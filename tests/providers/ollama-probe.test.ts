import { describe, expect, test } from 'bun:test';
import { ollamaReadiness, probeOllama } from '../../src/providers/ollama/probe.ts';

const jsonRes = (obj: unknown): Response => new Response(JSON.stringify(obj), { status: 200 });

// Route GET probes by path; an absent handler throws (simulating a daemon that's
// down or an endpoint that errored).
const fetchFor = (handlers: { version?: () => Response; tags?: () => Response }) =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/api/version')) {
      if (handlers.version) {
        return handlers.version();
      }
      throw new TypeError('connection refused');
    }
    if (u.endsWith('/api/tags')) {
      if (handlers.tags) {
        return handlers.tags();
      }
      throw new Error('tags unavailable');
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;

describe('probeOllama', () => {
  test('reachable daemon → version + pulled models', async () => {
    const fn = fetchFor({
      version: () => jsonRes({ version: '0.5.7' }),
      tags: () => jsonRes({ models: [{ name: 'qwen2.5-coder:14b' }, { name: 'llama3:latest' }] }),
    });
    const p = await probeOllama('http://localhost:11434', fn);
    expect(p.reachable).toBe(true);
    expect(p.version).toBe('0.5.7');
    expect(p.models).toEqual(['qwen2.5-coder:14b', 'llama3:latest']);
  });

  test('unreachable daemon → reachable:false with error', async () => {
    const p = await probeOllama('http://localhost:11434', fetchFor({}));
    expect(p.reachable).toBe(false);
    expect(p.error).toBeDefined();
  });

  test('version reachable but /api/tags fails → still reachable, models undefined', async () => {
    const fn = fetchFor({ version: () => jsonRes({ version: '0.9.0' }) });
    const p = await probeOllama('http://localhost:11434', fn);
    expect(p.reachable).toBe(true);
    expect(p.version).toBe('0.9.0');
    expect(p.models).toBeUndefined();
  });
});

describe('ollamaReadiness', () => {
  test('unreachable → fail with a serve hint', () => {
    const r = ollamaReadiness({ reachable: false, error: 'refused' });
    expect(r.status).toBe('fail');
    expect(r.remediation).toContain('ollama serve');
  });

  test('old version → warn with an update hint', () => {
    const r = ollamaReadiness(
      { reachable: true, version: '0.5.7', models: [] },
      { minVersion: '0.9.0' },
    );
    expect(r.status).toBe('warn');
    expect(r.remediation).toContain('Update Ollama');
  });

  test('model not pulled → warn with a pull hint', () => {
    const r = ollamaReadiness(
      { reachable: true, version: '0.9.0', models: ['llama3:latest'] },
      { model: 'qwen2.5-coder:14b', minVersion: '0.9.0' },
    );
    expect(r.status).toBe('warn');
    expect(r.remediation).toContain('ollama pull qwen2.5-coder:14b');
  });

  test('model without a tag matches a pulled tagged name', () => {
    const r = ollamaReadiness(
      { reachable: true, version: '0.12.0', models: ['llama3:latest'] },
      { model: 'llama3', minVersion: '0.9.0' },
    );
    expect(r.status).toBe('ok');
  });

  test('unknown version with a minVersion → warn', () => {
    const r = ollamaReadiness({ reachable: true, models: [] }, { minVersion: '0.9.0' });
    expect(r.status).toBe('warn');
    expect(r.remediation).toContain('Could not read');
  });

  test('v-prefix and pre-release suffix compare numerically', () => {
    expect(
      ollamaReadiness({ reachable: true, version: 'v0.12.0', models: [] }, { minVersion: '0.9.0' })
        .status,
    ).toBe('ok');
    expect(
      ollamaReadiness(
        { reachable: true, version: '0.5.0-rc1', models: [] },
        { minVersion: '0.9.0' },
      ).status,
    ).toBe('warn');
  });

  test('reachable + recent + model pulled → ok with no remediation', () => {
    const r = ollamaReadiness(
      { reachable: true, version: '0.12.0', models: ['qwen2.5-coder:14b'] },
      { model: 'qwen2.5-coder:14b', minVersion: '0.9.0' },
    );
    expect(r.status).toBe('ok');
    expect(r.remediation).toBeUndefined();
  });
});
