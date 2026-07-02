import { describe, expect, test } from 'bun:test';
import type { ParsedArgs } from '../../src/cli/args.ts';
import { operatorBootstrapFlags, reportRefusingEngine } from '../../src/cli/boot-parity.ts';
import type { BootstrapResult } from '../../src/cli/bootstrap.ts';

// Minimal valid ParsedArgs — only the required (non-optional) fields.
// Tests spread overrides on top to exercise individual flags.
const makeArgs = (overrides: Partial<ParsedArgs> = {}): ParsedArgs => ({
  prompt: '',
  json: false,
  version: false,
  help: false,
  listSessions: false,
  explainPermissions: false,
  listModels: false,
  includeSubagents: false,
  yes: false,
  ...overrides,
});

type RefusingFields = Pick<
  BootstrapResult,
  'permissionState' | 'permissionRefusingReason' | 'permissionChain'
>;

describe('operatorBootstrapFlags', () => {
  test('omits every flag when none are set (no undefined keys leak)', () => {
    const out = operatorBootstrapFlags(makeArgs());
    expect(out).toEqual({});
    // exactOptionalPropertyTypes contract: absent flags are OUT of the
    // object, not present-with-undefined — so a caller spread can't
    // clobber a bootstrapOverride.
    expect('approvalPosture' in out).toBe(false);
    expect('acceptBrokenChain' in out).toBe(false);
  });

  test('--autonomous maps to autonomous approval posture', () => {
    expect(operatorBootstrapFlags(makeArgs({ autonomous: true }))).toEqual({
      approvalPosture: 'autonomous',
    });
  });

  test('forwards the boot-blocking + sandbox/broker flags', () => {
    const out = operatorBootstrapFlags(
      makeArgs({ acceptBrokenChain: true, sandboxHost: true, brokerMode: 'spawn' }),
    );
    expect(out).toEqual({
      acceptBrokenChain: true,
      sandboxHost: true,
      brokerMode: 'spawn',
    });
  });

  // --auto-approve-mcp must thread identically from both entrypoints so a CI
  // operator's MCP trust opt-in works whether they invoke run.ts or repl.ts.
  test('forwards --auto-approve-mcp', () => {
    const servers = new Set(['postgres', 'github']);
    expect(operatorBootstrapFlags(makeArgs({ autoApproveMcp: servers }))).toEqual({
      autoApproveMcp: servers,
    });
    // Absent ⇒ key omitted (no accidental opt-in via the spread).
    expect('autoApproveMcp' in operatorBootstrapFlags(makeArgs())).toBe(false);
  });

  // Gate 2 of host passthrough (SECURITY.md §4.1/§4.7). The opt-in must be
  // forwarded by the SHARED flag map so the one-shot (run.ts) and REPL
  // paths thread it identically — pairs with --sandbox-host above.
  test('forwards --i-know-what-im-doing (host passthrough gate 2)', () => {
    expect(operatorBootstrapFlags(makeArgs({ iKnowWhatImDoing: true }))).toEqual({
      iKnowWhatImDoing: true,
    });
    // Both host gates forwarded together — the combination that unlocks
    // unsandboxed execution.
    expect(operatorBootstrapFlags(makeArgs({ sandboxHost: true, iKnowWhatImDoing: true }))).toEqual(
      {
        sandboxHost: true,
        iKnowWhatImDoing: true,
      },
    );
    // Absent ⇒ key omitted (no accidental opt-in via a spread).
    expect('iKnowWhatImDoing' in operatorBootstrapFlags(makeArgs())).toBe(false);
  });

  test('forwards model / noRecap / maxSteps', () => {
    // `--model` also opts the run into model-pin autosave (persistModelPin),
    // so the next start resolves to the chosen id without re-passing the flag.
    expect(
      operatorBootstrapFlags(makeArgs({ model: 'anthropic/x', noRecap: true, maxSteps: 7 })),
    ).toEqual({
      modelId: 'anthropic/x',
      persistModelPin: true,
      noRecap: true,
      budget: { maxSteps: 7 },
    });
  });

  test('persistModelPin rides with --model and is omitted without it', () => {
    expect('persistModelPin' in operatorBootstrapFlags(makeArgs({ model: 'anthropic/x' }))).toBe(
      true,
    );
    expect('persistModelPin' in operatorBootstrapFlags(makeArgs())).toBe(false);
  });

  test('memory toggles propagate BOTH true and false (Slice Q)', () => {
    expect(operatorBootstrapFlags(makeArgs({ memoryVerifyLlm: false }))).toEqual({
      memorySemanticVerify: false,
    });
    expect(
      operatorBootstrapFlags(
        makeArgs({ memoryVerifyLlm: true, memoryConflictLlm: false, memoryOverrideLlm: true }),
      ),
    ).toEqual({
      memorySemanticVerify: true,
      memoryConflictDetect: false,
      memoryOverrideDetect: true,
    });
  });
});

describe('reportRefusingEngine', () => {
  const sink = () => {
    let text = '';
    return {
      write: (s: string) => {
        text += s;
      },
      get: () => text,
    };
  };

  test('returns false and emits nothing when the engine is ready', () => {
    const s = sink();
    const fields = {
      permissionState: 'ready',
      permissionChain: { ok: true, rows: 0, current_rotation_id: 0, quarantined: false },
    } as unknown as RefusingFields;
    expect(reportRefusingEngine(fields, s.write)).toBe(false);
    expect(s.get()).toBe('');
  });

  test('refusing with an intact chain emits only the headline (no chain detail)', () => {
    const s = sink();
    const fields = {
      permissionState: 'refusing',
      permissionRefusingReason: 'sandbox_required_but_unavailable',
      permissionChain: { ok: true, rows: 0, current_rotation_id: 0, quarantined: false },
    } as unknown as RefusingFields;
    expect(reportRefusingEngine(fields, s.write)).toBe(true);
    expect(s.get()).toContain(
      'permission engine refused to start — sandbox_required_but_unavailable',
    );
    expect(s.get()).not.toContain('chain broken');
  });

  test('refusing with a broken chain emits the chain detail + recovery hint', () => {
    const s = sink();
    const fields = {
      permissionState: 'refusing',
      permissionRefusingReason: 'chain_broken',
      permissionChain: {
        ok: false,
        brokenAt: 3,
        reason: 'hash_mismatch',
        expected: 'a',
        actual: 'b',
      },
    } as unknown as RefusingFields;
    expect(reportRefusingEngine(fields, s.write)).toBe(true);
    const out = s.get();
    expect(out).toContain('chain broken at seq 3 (hash_mismatch)');
    expect(out).toContain('--accept-broken-chain');
    expect(out).toContain('chain-break-accepted');
  });

  test('falls back to "unknown" when no refusing reason is provided', () => {
    const s = sink();
    const fields = {
      permissionState: 'refusing',
      permissionChain: { ok: true, rows: 0, current_rotation_id: 0, quarantined: false },
    } as unknown as RefusingFields;
    expect(reportRefusingEngine(fields, s.write)).toBe(true);
    expect(s.get()).toContain('refused to start — unknown');
  });
});
