import { describe, expect, test } from 'bun:test';
import {
  createVerifyState,
  matchesVerifyCommand,
  recordToolForVerify,
  unsatisfiedVerifyCommands,
  verifyGateNudge,
} from '../../src/harness/verify-gate.ts';

const CMDS = ['bun run typecheck', 'bun test'];

describe('matchesVerifyCommand (whole-command equality only)', () => {
  test('credits the declared command run verbatim (ws-collapsed), incl. a declared compound', () => {
    expect(matchesVerifyCommand('bun test', 'bun test')).toBe(true);
    expect(matchesVerifyCommand('bun    test', 'bun test')).toBe(true); // ws-collapse
    // An operator who needs a prefix declares that EXACT string; running it
    // verbatim is a whole-command match.
    expect(matchesVerifyCommand('cd app && bun test', 'cd app && bun test')).toBe(true);
    expect(matchesVerifyCommand('bun run lint && bun test', 'bun run lint && bun test')).toBe(true);
  });

  test('does NOT credit the declared command as a SEGMENT of a larger command', () => {
    // Segment matching is unsound — the tool reports one OVERALL exit code.
    expect(matchesVerifyCommand('cd app && bun test', 'bun test')).toBe(false); // && conjunct, not whole
    expect(matchesVerifyCommand('lint && bun test && echo ok', 'bun test')).toBe(false);
    // Masking operators: exit 0 even though `bun test` failed or was skipped.
    expect(matchesVerifyCommand('bun test || true', 'bun test')).toBe(false);
    expect(matchesVerifyCommand('bun test; true', 'bun test')).toBe(false);
    expect(matchesVerifyCommand('bun test | cat', 'bun test')).toBe(false);
    expect(matchesVerifyCommand('lint || bun test', 'bun test')).toBe(false);
    // A `&&` inside a quoted string is NOT a real conjunction — `bun test` never
    // ran here. Whole-command equality sidesteps the whole parsing class.
    expect(matchesVerifyCommand('echo "x && bun test && y"', 'bun test')).toBe(false);
  });

  test('EXACT only — no prefix/substring/wrapper (false-positives that would defeat the gate)', () => {
    // A no-op sibling subcommand (runs zero tests, exits 0) must NOT satisfy it.
    expect(matchesVerifyCommand('bun test --help', 'bun test')).toBe(false);
    // A mere mention inside a quoted string must NOT satisfy it.
    expect(matchesVerifyCommand('git commit -m "fix; bun test passes"', 'bun test')).toBe(false);
    expect(matchesVerifyCommand('echo bun test', 'bun test')).toBe(false);
    // A leading wrapper is not the whole declared command.
    expect(matchesVerifyCommand('CI=1 bun test', 'bun test')).toBe(false);
    // A declared prefix must NOT match a different subcommand.
    expect(matchesVerifyCommand('bun install', 'bun')).toBe(false);
    expect(matchesVerifyCommand('bun', 'bun test')).toBe(false);
    expect(matchesVerifyCommand('anything', '')).toBe(false);
  });
});

describe('verify-gate accounting', () => {
  test('gate is off when no commands are declared', () => {
    const s = createVerifyState();
    recordToolForVerify(s, [], 'edit_file', { path: 'a.ts' }, false, undefined);
    expect(unsatisfiedVerifyCommands(s, [])).toEqual([]);
  });

  test('no mutation → nothing to verify (gate does not fire)', () => {
    const s = createVerifyState();
    // A bash that passes but no file was edited.
    recordToolForVerify(s, CMDS, 'bash', { command: 'bun test' }, false, undefined);
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual([]);
  });

  test('mutation without verify → all commands unsatisfied', () => {
    const s = createVerifyState();
    recordToolForVerify(s, CMDS, 'edit_file', { path: 'a.ts' }, false, undefined);
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual(CMDS);
  });

  test('mutation then each verify passing clears it', () => {
    const s = createVerifyState();
    recordToolForVerify(s, CMDS, 'write_file', { path: 'a.ts' }, false, undefined);
    recordToolForVerify(s, CMDS, 'bash', { command: 'bun run typecheck' }, false, undefined);
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual(['bun test']);
    recordToolForVerify(s, CMDS, 'bash', { command: 'bun test' }, false, undefined);
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual([]);
  });

  test('a NEW mutation invalidates prior verify evidence', () => {
    const s = createVerifyState();
    recordToolForVerify(s, CMDS, 'edit_file', { path: 'a.ts' }, false, undefined);
    recordToolForVerify(s, CMDS, 'bash', { command: 'bun run typecheck' }, false, undefined);
    recordToolForVerify(s, CMDS, 'bash', { command: 'bun test' }, false, undefined);
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual([]); // all verified
    // Editing again post-verification re-arms the gate.
    recordToolForVerify(s, CMDS, 'edit_file', { path: 'a.ts' }, false, undefined);
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual(CMDS);
  });

  test('a verify that ran BEFORE the mutation does not count', () => {
    const s = createVerifyState();
    recordToolForVerify(s, CMDS, 'bash', { command: 'bun test' }, false, undefined); // before any edit
    recordToolForVerify(s, CMDS, 'edit_file', { path: 'a.ts' }, false, undefined);
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual(CMDS); // edit cleared it
  });

  test('a FAILED write is not a mutation; a non-zero bash is not a pass', () => {
    const s = createVerifyState();
    recordToolForVerify(s, CMDS, 'edit_file', { path: 'a.ts' }, true, undefined); // failed write
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual([]); // no mutation
    recordToolForVerify(s, CMDS, 'write_file', { path: 'a.ts' }, false, undefined); // real mutation
    recordToolForVerify(s, CMDS, 'bash', { command: 'bun test' }, false, 1); // exit 1
    recordToolForVerify(s, CMDS, 'bash', { command: 'bun run typecheck' }, false, undefined); // exit 0
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual(['bun test']); // only typecheck passed
  });

  test('bash_background does not count as a verify (no settled exit)', () => {
    const s = createVerifyState();
    recordToolForVerify(s, CMDS, 'edit_file', { path: 'a.ts' }, false, undefined);
    recordToolForVerify(s, CMDS, 'bash_background', { command: 'bun test' }, false, undefined);
    expect(unsatisfiedVerifyCommands(s, CMDS)).toEqual(CMDS);
  });
});

describe('verifyGateNudge', () => {
  test('names the unsatisfied commands and stays nudge-shaped (no auto-run)', () => {
    const one = verifyGateNudge(['bun test']);
    expect(one).toContain('`bun test`');
    expect(one).toContain('this command');
    const many = verifyGateNudge(CMDS);
    expect(many).toContain('`bun run typecheck`');
    expect(many).toContain('`bun test`');
    expect(many).toContain('these commands');
    expect(many.toLowerCase()).toContain('exit 0');
  });
});
