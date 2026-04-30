import { describe, expect, test } from 'bun:test';
import { parseArgs, usage } from '../../src/cli/args.ts';

describe('parseArgs', () => {
  test('plain prompt', () => {
    const r = parseArgs(['hello', 'world']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.prompt).toBe('hello world');
    expect(r.args.json).toBe(false);
    expect(r.args.version).toBe(false);
  });

  test('--version (and -v) flag', () => {
    for (const flag of ['--version', '-v']) {
      const r = parseArgs([flag]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.args.version).toBe(true);
    }
  });

  test('--help (and -h) flag', () => {
    for (const flag of ['--help', '-h']) {
      const r = parseArgs([flag]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.args.help).toBe(true);
    }
  });

  test('--json flag', () => {
    const r = parseArgs(['--json', 'do', 'thing']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.json).toBe(true);
    expect(r.args.prompt).toBe('do thing');
  });

  test('--plan flag', () => {
    const r = parseArgs(['--plan', 'refactor src/auth.ts']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.plan).toBe(true);
    expect(r.args.prompt).toBe('refactor src/auth.ts');
  });

  test('--plan defaults to false when omitted', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.plan).toBe(false);
  });

  test('--model with value', () => {
    const r = parseArgs(['--model', 'openai/gpt-4o', 'hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.model).toBe('openai/gpt-4o');
    expect(r.args.prompt).toBe('hi');
  });

  test('--model without value rejects', () => {
    const r = parseArgs(['--model']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--model requires a value');
  });

  test('--model swallows the next arg even if missing prompt', () => {
    const r = parseArgs(['--model', 'foo']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.model).toBe('foo');
    expect(r.args.prompt).toBe('');
  });

  test('--model rejects when next token is another flag', () => {
    const r = parseArgs(['--model', '--json']);
    expect(r.ok).toBe(false);
  });

  test('--max-steps parses positive integer', () => {
    const r = parseArgs(['--max-steps', '7', 'hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.maxSteps).toBe(7);
  });

  test('--max-steps rejects non-numeric', () => {
    const r = parseArgs(['--max-steps', 'abc']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--max-steps must be');
  });

  test('--max-steps rejects zero or negative', () => {
    expect(parseArgs(['--max-steps', '0']).ok).toBe(false);
    expect(parseArgs(['--max-steps', '-1']).ok).toBe(false);
  });

  test('--max-steps rejects decimals (would silently truncate via parseInt)', () => {
    const r = parseArgs(['--max-steps', '3.5']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("got '3.5'");
  });

  test('--max-steps rejects leading-zero / hex / scientific notation', () => {
    expect(parseArgs(['--max-steps', '0x10']).ok).toBe(false);
    expect(parseArgs(['--max-steps', '1e3']).ok).toBe(false);
    expect(parseArgs(['--max-steps', '007']).ok).toBe(false);
  });

  test('unknown flag rejects', () => {
    const r = parseArgs(['--bogus', 'hi']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('unknown flag: --bogus');
  });

  test('mixed flags and prompt', () => {
    const r = parseArgs(['--json', '--model', 'a/b', 'do', '--max-steps', '5', 'thing']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.json).toBe(true);
    expect(r.args.model).toBe('a/b');
    expect(r.args.maxSteps).toBe(5);
    expect(r.args.prompt).toBe('do thing');
  });

  test('empty argv', () => {
    const r = parseArgs([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.prompt).toBe('');
  });

  test('--list-sessions flag', () => {
    const r = parseArgs(['--list-sessions']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.listSessions).toBe(true);
  });

  test('--list-sessions composes with --json', () => {
    const r = parseArgs(['--list-sessions', '--json']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.listSessions).toBe(true);
    expect(r.args.json).toBe(true);
  });

  test('--include-subagents flag defaults to false and toggles on', () => {
    const off = parseArgs(['--list-sessions']);
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.args.includeSubagents).toBe(false);

    const on = parseArgs(['--list-sessions', '--include-subagents']);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.args.includeSubagents).toBe(true);
  });

  test('--include-subagents standalone (without --list-sessions) is a parse error', () => {
    // O3 fix. Prior behavior: the flag fell through to the run-mode
    // branch where no consumer read it, so the user got silent
    // ignore instead of feedback. Refusing at parse time surfaces
    // the misuse before bootstrap.
    const r = parseArgs(['--include-subagents']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--include-subagents requires --list-sessions');
  });

  test('--limit accepts positive integers and threads through args', () => {
    // The truncation hint emitted by `runListSessions` points
    // users at --limit explicitly, so the flag MUST exist and
    // accept the same shape as the cap the listing applies.
    const r = parseArgs(['--list-sessions', '--limit', '50']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.limit).toBe(50);
  });

  test('--limit rejects non-positive-integer values', () => {
    const cases = ['0', '-1', '3.5', 'abc', ''];
    for (const v of cases) {
      const r = parseArgs(['--list-sessions', '--limit', v]);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      // `--list-sessions --limit` (no value): the parser sees the
      // empty string slot as missing OR consumes the next token
      // depending on shape. Either form should produce an error.
      expect(r.message).toMatch(/--limit (must be a positive integer|requires a value)/);
    }
  });

  test('--limit standalone (without --list-sessions) is a parse error', () => {
    // Same combo-rule as --include-subagents. The flag is purely
    // a listing concern; standalone use is a configuration
    // mistake worth surfacing at parse time.
    const r = parseArgs(['--limit', '10']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--limit requires --list-sessions');
  });

  test('--include-subagents combined with a normal prompt is a parse error', () => {
    // Even with a prompt that would otherwise initiate a run, the
    // flag is meaningless without --list-sessions. We refuse rather
    // than picking one interpretation silently.
    const r = parseArgs(['--include-subagents', 'do', 'something']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--include-subagents requires --list-sessions');
  });

  test('--resume requires a value', () => {
    const r = parseArgs(['--resume']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--resume');
  });

  test('--resume with literal id', () => {
    const r = parseArgs(['--resume', 'abc-123', 'follow up']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.resume).toBe('abc-123');
    expect(r.args.prompt).toBe('follow up');
  });

  test('--resume last is accepted as a value', () => {
    const r = parseArgs(['--resume', 'last', 'continue please']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.resume).toBe('last');
    expect(r.args.prompt).toBe('continue please');
  });

  test('--resume rejects another flag as its value', () => {
    // Defends against `--resume --json` being misread as resume
    // value '--json'. Forces the user to provide an explicit id
    // or 'last'.
    const r = parseArgs(['--resume', '--json']);
    expect(r.ok).toBe(false);
  });
});

describe('--undo flag', () => {
  test('captures the session id', () => {
    const r = parseArgs(['--undo', 'sess-123']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.undo).toBe('sess-123');
  });

  test('rejects when no value follows', () => {
    const r = parseArgs(['--undo']);
    expect(r.ok).toBe(false);
  });

  test('rejects when next token is another flag', () => {
    const r = parseArgs(['--undo', '--json']);
    expect(r.ok).toBe(false);
  });
});

describe('--yes / -y flag', () => {
  test('default is false', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.yes).toBe(false);
  });

  test('--yes sets the flag', () => {
    const r = parseArgs(['--yes']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.yes).toBe(true);
  });

  test('-y short form sets the flag', () => {
    const r = parseArgs(['-y']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.yes).toBe(true);
  });
});

describe('--checkpoints flag', () => {
  test('list with one positional', () => {
    const r = parseArgs(['--checkpoints', 'list', 'sess-1']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.checkpoints).toEqual({ verb: 'list', positionals: ['sess-1'] });
  });

  test('diff captures both positionals', () => {
    const r = parseArgs(['--checkpoints', 'diff', 'sess', 'ckpt']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.checkpoints?.positionals).toEqual(['sess', 'ckpt']);
  });

  test('positional collection stops at the next flag', () => {
    const r = parseArgs(['--checkpoints', 'list', 'sess', '--json']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.checkpoints?.positionals).toEqual(['sess']);
    expect(r.args.json).toBe(true);
  });

  test('positional collection stops at short flags too', () => {
    // Bug repro: `--checkpoints restore <session> <ckpt> -y` was
    // swallowing `-y` as a positional, leaving yes=false and breaking
    // had-bash restores. The greedy scan only stopped at `--` prefix
    // tokens; short flags are equally valid breakpoints.
    const r = parseArgs(['--checkpoints', 'restore', 'sess', 'ckpt', '-y']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.checkpoints?.positionals).toEqual(['sess', 'ckpt']);
    expect(r.args.yes).toBe(true);
  });

  test('rejects when no verb is given', () => {
    expect(parseArgs(['--checkpoints']).ok).toBe(false);
    expect(parseArgs(['--checkpoints', '--json']).ok).toBe(false);
  });

  test('rejects an unknown verb', () => {
    const r = parseArgs(['--checkpoints', 'foobar']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('unknown');
  });
});

describe('--subagent-session-id', () => {
  test('captures the value into args.subagentSessionId', () => {
    const r = parseArgs(['--subagent-session-id', 'abc-123']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentSessionId).toBe('abc-123');
  });

  test('rejects when value is missing', () => {
    expect(parseArgs(['--subagent-session-id']).ok).toBe(false);
    expect(parseArgs(['--subagent-session-id', '--json']).ok).toBe(false);
  });

  test('absent by default', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentSessionId).toBeUndefined();
  });
});

describe('usage', () => {
  test('mentions every recognized flag', () => {
    const u = usage();
    expect(u).toContain('--version');
    expect(u).toContain('--help');
    expect(u).toContain('--json');
    expect(u).toContain('--plan');
    expect(u).toContain('--model');
    expect(u).toContain('--max-steps');
    expect(u).toContain('--list-sessions');
    expect(u).toContain('--resume');
    expect(u).toContain('--undo');
    expect(u).toContain('--checkpoints');
    expect(u).toContain('--yes');
  });
});
