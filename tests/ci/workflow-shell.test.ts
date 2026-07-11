import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

// A malformed `run:` block — an unterminated if/else, a stray `fi`, an
// unclosed quote — can stay valid YAML while breaking the shell at CI
// time. That is exactly how an appended job once orphaned the `fi`
// closing the GitHub Release step: YAML folded it into the next step's
// plain `run` scalar, the file parsed fine, and the release step would
// have failed on an unterminated `if`. Syntax-check every workflow `run`
// block with `bash -n` so that class of break fails here, not in a
// release.

const WORKFLOW_DIR = resolve(import.meta.dir, '../../.github/workflows');

interface RunBlock {
  file: string;
  label: string;
  script: string;
}

const collectRunBlocks = (): RunBlock[] => {
  const out: RunBlock[] = [];
  if (!existsSync(WORKFLOW_DIR)) return out;
  const files = readdirSync(WORKFLOW_DIR).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'));
  for (const file of files) {
    const doc = parse(readFileSync(join(WORKFLOW_DIR, file), 'utf-8')) as {
      jobs?: Record<string, { steps?: { name?: string; uses?: string; run?: unknown }[] }>;
    };
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        out.push({
          file,
          label: `${jobName} / ${step.name ?? step.uses ?? '?'}`,
          script: step.run,
        });
      }
    }
  }
  return out;
};

describe('workflow run blocks are syntactically valid bash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-wf-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const blocks = collectRunBlocks();

  // Guard the guard: if discovery silently returned nothing (moved dir,
  // parser change), the per-block tests below would vacuously pass.
  test('discovers workflow run blocks', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  blocks.forEach((b, i) => {
    test(`${b.file} :: ${b.label}`, () => {
      const f = join(dir, `step-${i}.sh`);
      writeFileSync(f, b.script);
      const r = spawnSync('bash', ['-n', f], { encoding: 'utf-8' });
      // `bash -n` is silent on success and prints the reason to stderr on
      // a syntax error — assert stderr first so the failure is legible.
      expect(r.stderr.trim()).toBe('');
      expect(r.status).toBe(0);
    });
  });
});
