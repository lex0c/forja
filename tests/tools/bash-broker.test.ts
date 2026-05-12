// Slice 82 contract tests — verifies bashTool's broker-routed
// path translates BrokerResponse shapes correctly into BashOutput
// / ToolError vocabulary. These are complementary to
// `tests/tools/bash.test.ts` (which exercises behavior end-to-end
// against the real bash handler via makeCtx's default broker);
// here we use a SCRIPTED broker so we can pin every translation
// branch.

import { describe, expect, test } from 'bun:test';
import type { Broker, BrokerRequest, BrokerResponse } from '../../src/broker/index.ts';
import { bashTool } from '../../src/tools/builtin/bash.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const scripted = (response: BrokerResponse | ((req: BrokerRequest) => BrokerResponse)): Broker => {
  return {
    execute: async (req) => (typeof response === 'function' ? response(req) : response),
    close: async () => undefined,
  };
};

const capturing = (): {
  broker: Broker;
  getRequest: () => BrokerRequest;
  getCallOptions: () => { signal?: AbortSignal; timeoutMs?: number };
} => {
  const state: {
    request: BrokerRequest | null;
    callOptions: { signal?: AbortSignal; timeoutMs?: number };
  } = { request: null, callOptions: {} };
  const broker: Broker = {
    execute: async (req, opts) => {
      state.request = req;
      state.callOptions = opts ?? {};
      return { ok: true, stdout: '', stderr: '', exitCode: 0 };
    },
    close: async () => undefined,
  };
  const getRequest = (): BrokerRequest => {
    if (state.request === null) throw new Error('broker.execute was not called');
    return state.request;
  };
  const getCallOptions = (): { signal?: AbortSignal; timeoutMs?: number } => state.callOptions;
  return { broker, getRequest, getCallOptions };
};

describe('bashTool — broker routing contract', () => {
  test('routes through ctx.broker, never spawns directly', async () => {
    const { broker, getRequest } = capturing();
    await bashTool.execute({ command: 'echo hi' }, makeCtx({ broker }));
    const r = getRequest();
    expect(r.toolName).toBe('bash');
    expect(r.args.command).toBe('echo hi');
  });

  test('resolves relative args.cwd to absolute against ctx.cwd before broker hop', async () => {
    const { broker, getRequest } = capturing();
    await bashTool.execute(
      { command: 'pwd', cwd: 'sub/dir' },
      makeCtx({ broker, cwd: '/work/proj' }),
    );
    expect(getRequest().args.cwd).toBe('/work/proj/sub/dir');
  });

  test('absolute args.cwd is passed through unchanged', async () => {
    const { broker, getRequest } = capturing();
    await bashTool.execute(
      { command: 'pwd', cwd: '/abs/path' },
      makeCtx({ broker, cwd: '/work/proj' }),
    );
    expect(getRequest().args.cwd).toBe('/abs/path');
  });

  test('missing args.cwd: ctx.cwd substituted', async () => {
    const { broker, getRequest } = capturing();
    await bashTool.execute({ command: 'pwd' }, makeCtx({ broker, cwd: '/work/proj' }));
    expect(getRequest().args.cwd).toBe('/work/proj');
  });

  test('sandboxProfile from ctx flows into BrokerRequest', async () => {
    const { broker, getRequest } = capturing();
    await bashTool.execute({ command: 'echo' }, makeCtx({ broker, sandboxProfile: 'cwd-rw' }));
    expect(getRequest().sandboxProfile).toBe('cwd-rw');
  });

  test('missing sandboxProfile becomes null on the wire', async () => {
    const { broker, getRequest } = capturing();
    await bashTool.execute({ command: 'echo' }, makeCtx({ broker }));
    expect(getRequest().sandboxProfile).toBeNull();
  });

  test('passes ctx.signal to broker.execute via callOptions', async () => {
    const { broker, getCallOptions } = capturing();
    const ctrl = new AbortController();
    await bashTool.execute({ command: 'echo' }, makeCtx({ broker, signal: ctrl.signal }));
    expect(getCallOptions().signal).toBe(ctrl.signal);
  });

  test('computes brokerTimeoutMs from args.timeout_ms + grace + buffer', async () => {
    const { broker, getCallOptions } = capturing();
    // args.timeout_ms = 5000; brokerTimeoutMs = 5000 + 2000 (grace) + 10000 (buffer)
    await bashTool.execute({ command: 'echo', timeout_ms: 5000 }, makeCtx({ broker }));
    expect(getCallOptions().timeoutMs).toBe(17_000);
  });

  test('uses BASH_DEFAULT_TIMEOUT_MS when args.timeout_ms is absent', async () => {
    const { broker, getCallOptions } = capturing();
    // default 30000 + 2000 + 10000 = 42000
    await bashTool.execute({ command: 'echo' }, makeCtx({ broker }));
    expect(getCallOptions().timeoutMs).toBe(42_000);
  });
});

describe('bashTool — BrokerResponse translation', () => {
  test('ok:true with exitCode 0 → BashOutput shape', async () => {
    const broker = scripted({
      ok: true,
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
    });
    const out = await bashTool.execute({ command: 'echo hello' }, makeCtx({ broker }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.stdout).toBe('hello\n');
    expect(out.exit_code).toBe(0);
    expect(out.timed_out).toBe(false);
    expect(out.truncated).toBe(false);
    expect(typeof out.duration_ms).toBe('number');
  });

  test('ok:false with non-zero exitCode → BashOutput (not error)', async () => {
    const broker = scripted({
      ok: false,
      stdout: '',
      stderr: 'nope',
      exitCode: 17,
    });
    const out = await bashTool.execute({ command: 'exit 17' }, makeCtx({ broker }));
    if (isToolError(out)) throw new Error('expected BashOutput, got ToolError');
    expect(out.exit_code).toBe(17);
    expect(out.stderr).toBe('nope');
  });

  test('stdoutTruncated flag → truncated:true', async () => {
    // Slice 117: the bash tool reads `stdoutTruncated` / `stderrTruncated`
    // directly from BrokerResponse. The trailing footer text is
    // informational for the operator but no longer the source of
    // truth for the truncated flag.
    const broker = scripted({
      ok: true,
      stdout: 'data\n[... truncated; 100 bytes omitted]',
      stderr: '',
      exitCode: 0,
      stdoutTruncated: true,
    });
    const out = await bashTool.execute({ command: 'dd' }, makeCtx({ broker }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.truncated).toBe(true);
  });

  test('stderrTruncated flag → truncated:true', async () => {
    const broker = scripted({
      ok: true,
      stdout: '',
      stderr: 'noise\n[... truncated; 50 bytes omitted]',
      exitCode: 0,
      stderrTruncated: true,
    });
    const out = await bashTool.execute({ command: 'dd' }, makeCtx({ broker }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.truncated).toBe(true);
  });

  test('user output literally ending in truncation marker WITHOUT flags → truncated:false (slice 117 false-positive fix)', async () => {
    // Pre-slice the regex matched this and set truncated:true even
    // though the handler didn't truncate. Now the flag-only path
    // refuses to false-positive on user-quoted content.
    const broker = scripted({
      ok: true,
      stdout: 'echoed\n[... truncated; 42 bytes omitted]',
      stderr: '',
      exitCode: 0,
      // No stdoutTruncated / stderrTruncated flags — handler did
      // NOT truncate; user output happened to contain the marker.
    });
    const out = await bashTool.execute({ command: 'echo' }, makeCtx({ broker }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.truncated).toBe(false);
  });

  test('no truncation footer → truncated:false', async () => {
    const broker = scripted({
      ok: true,
      stdout: 'short',
      stderr: 'also short',
      exitCode: 0,
    });
    const out = await bashTool.execute({ command: 'echo' }, makeCtx({ broker }));
    if (isToolError(out)) throw new Error('unexpected error');
    expect(out.truncated).toBe(false);
  });
});

describe('bashTool — BrokerResponse error mapping', () => {
  test('handler timeout error → bash.timeout', async () => {
    const broker = scripted({
      ok: false,
      stdout: '',
      stderr: '',
      error: 'bash handler: timed out after 500ms',
    });
    const out = await bashTool.execute({ command: 'sleep 60' }, makeCtx({ broker }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('bash.timeout');
    expect(out.error_message).toContain('500ms');
  });

  test('handler spawn-failed error → bash.spawn_failed', async () => {
    const broker = scripted({
      ok: false,
      stdout: '',
      stderr: '',
      error: 'bash handler: failed to spawn bash: ENOENT bash',
    });
    const out = await bashTool.execute({ command: 'echo' }, makeCtx({ broker }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('bash.spawn_failed');
    expect(out.error_message).toContain('ENOENT bash');
  });

  test('handler invalid-arg error → tool.invalid_arg', async () => {
    const broker = scripted({
      ok: false,
      stdout: '',
      stderr: '',
      error: 'bash handler: args.command must be a non-empty string',
    });
    const out = await bashTool.execute({ command: 'x' }, makeCtx({ broker }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('tool.invalid_arg');
    expect(out.error_message).toContain('args.command');
  });

  test('unknown broker error → bash.spawn_failed (catch-all)', async () => {
    const broker = scripted({
      ok: false,
      stdout: '',
      stderr: '',
      error: 'broker closed',
    });
    const out = await bashTool.execute({ command: 'echo' }, makeCtx({ broker }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('bash.spawn_failed');
    expect(out.error_message).toContain('broker closed');
  });

  test('response with no exitCode AND no error → bash.spawn_failed', async () => {
    const broker = scripted({
      ok: false,
      stdout: '',
      stderr: '',
    });
    const out = await bashTool.execute({ command: 'echo' }, makeCtx({ broker }));
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('bash.spawn_failed');
    expect(out.error_message).toContain('no exit code');
  });
});

describe('bashTool — broker absent', () => {
  test('ctx without broker → bash.spawn_failed', async () => {
    // Build ctx without the default broker — exactOptionalPropertyTypes
    // blocks `{broker: undefined}` directly, so destructure the field
    // out of the ToolContext built by makeCtx.
    const { broker: _drop, ...ctx } = makeCtx();
    const out = await bashTool.execute({ command: 'echo' }, ctx);
    if (!isToolError(out)) throw new Error('expected error');
    expect(out.error_code).toBe('bash.spawn_failed');
    expect(out.error_message).toContain('broker');
  });
});
