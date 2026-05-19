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

  test('--explain-permissions flag defaults off and toggles on', () => {
    const off = parseArgs(['hello']);
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.args.explainPermissions).toBe(false);

    const on = parseArgs(['--explain-permissions']);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.args.explainPermissions).toBe(true);
    // Standalone — no positional prompt required (it's an
    // inspection-only flag).
    expect(on.args.prompt).toBe('');
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

describe('--subagent-depth', () => {
  test('captures non-negative integer into args.subagentDepth', () => {
    for (const value of ['0', '1', '4', '99']) {
      const r = parseArgs(['--subagent-depth', value]);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.args.subagentDepth).toBe(Number.parseInt(value, 10));
    }
  });

  test('rejects when value is missing', () => {
    expect(parseArgs(['--subagent-depth']).ok).toBe(false);
  });

  test('rejects negative or non-integer values', () => {
    for (const bad of ['-1', '1.5', 'abc', '03', '']) {
      const r = parseArgs(['--subagent-depth', bad]);
      expect(r.ok).toBe(false);
    }
  });

  test('absent by default', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentDepth).toBeUndefined();
  });
});

describe('--subagent-temperature', () => {
  test('captures finite non-negative number into args.subagentTemperature', () => {
    for (const value of ['0', '0.0', '0.5', '1', '1.5', '2.0', '0.0001']) {
      const r = parseArgs(['--subagent-temperature', value]);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.args.subagentTemperature).toBe(Number.parseFloat(value));
    }
  });

  test('rejects when value is missing', () => {
    expect(parseArgs(['--subagent-temperature']).ok).toBe(false);
  });

  test('rejects negative values', () => {
    expect(parseArgs(['--subagent-temperature', '-0.1']).ok).toBe(false);
    expect(parseArgs(['--subagent-temperature', '-1']).ok).toBe(false);
  });

  test('rejects non-finite (NaN, Infinity, garbage)', () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity', 'abc', '']) {
      const r = parseArgs(['--subagent-temperature', bad]);
      expect(r.ok).toBe(false);
    }
  });

  test('rejects leading-digit garbage like "1abc" (parseFloat footgun defense)', () => {
    // Number.parseFloat('1abc') returns 1 — the parser's earlier
    // implementation would have silently accepted it as
    // temperature=1. Number() returns NaN for partial matches,
    // caught by the finite check. This test locks the strict
    // interpretation so a future revert to parseFloat surfaces.
    for (const bad of ['1abc', '1.5xyz', '0e', '.', '1..5', '+', '-']) {
      const r = parseArgs(['--subagent-temperature', bad]);
      expect(r.ok).toBe(false);
    }
  });

  test('absent by default — child falls through to provider default', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentTemperature).toBeUndefined();
  });
});

describe('--subagent-plan-mode', () => {
  test('presence-only flag sets args.subagentPlanMode = true', () => {
    const r = parseArgs(['--subagent-plan-mode']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentPlanMode).toBe(true);
  });

  test('absent by default — child runs without plan-mode gate', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentPlanMode).toBeUndefined();
  });

  test('coexists with --subagent-session-id and --subagent-depth', () => {
    // The internal flags arrive together in the spawn command;
    // the parser must accept any order.
    const r = parseArgs([
      '--subagent-session-id',
      'abc',
      '--subagent-depth',
      '2',
      '--subagent-plan-mode',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentSessionId).toBe('abc');
    expect(r.args.subagentDepth).toBe(2);
    expect(r.args.subagentPlanMode).toBe(true);
  });
});

describe('--subagent-bg-log-dir', () => {
  test('captures path into args.subagentBgLogDir', () => {
    const r = parseArgs(['--subagent-bg-log-dir', '/var/cache/agent/bg/sub-id']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentBgLogDir).toBe('/var/cache/agent/bg/sub-id');
  });

  test('rejects when value is missing or empty', () => {
    expect(parseArgs(['--subagent-bg-log-dir']).ok).toBe(false);
    expect(parseArgs(['--subagent-bg-log-dir', '']).ok).toBe(false);
  });

  test('rejects flag-shaped value (would otherwise eat the next internal flag)', () => {
    // Without the startsWith('--') guard, the path consumer
    // would silently swallow `--subagent-depth` and start the
    // child with bgLogDir='--subagent-depth' AND no depth
    // value — wrong runtime state with no error surfaced.
    expect(parseArgs(['--subagent-bg-log-dir', '--subagent-depth', '2']).ok).toBe(false);
    expect(parseArgs(['--subagent-bg-log-dir', '--json']).ok).toBe(false);
    expect(parseArgs(['--subagent-bg-log-dir', '--']).ok).toBe(false);
  });

  test('absent by default — child runs without bg manager', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentBgLogDir).toBeUndefined();
  });
});

describe('--subagent-cwd-trusted', () => {
  test('captures true when present', () => {
    const r = parseArgs(['--subagent-session-id', 'sess-x', '--subagent-cwd-trusted']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentCwdTrusted).toBe(true);
  });

  test('absent by default — child treats cwd as untrusted', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentCwdTrusted).toBeUndefined();
  });

  test('coexists with other internal subagent flags', () => {
    const r = parseArgs([
      '--subagent-session-id',
      'sess-x',
      '--subagent-cwd-trusted',
      '--subagent-plan-mode',
      '--ipc=1',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentCwdTrusted).toBe(true);
    expect(r.args.subagentPlanMode).toBe(true);
    expect(r.args.subagentIpcVersion).toBe(1);
  });
});

describe('--ipc', () => {
  test('--ipc=<n> paired with --subagent-session-id captures protocol version', () => {
    const r = parseArgs(['--subagent-session-id', 'sess-x', '--ipc=1']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentIpcVersion).toBe(1);
  });

  test('--ipc (no value) defaults to version 1 when paired', () => {
    // Ergonomic shorthand for dev / manual debugging — the
    // parent always sends the explicit version, but a human
    // typing `--ipc` directly inside subagent-child mode
    // should not get a parser error on the value side. The
    // outer pair-check still requires --subagent-session-id.
    const r = parseArgs(['--subagent-session-id', 'sess-x', '--ipc']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentIpcVersion).toBe(1);
  });

  test('rejects non-positive integers (value validation fires before pair check)', () => {
    // Even paired correctly, bogus values fail at the
    // per-flag value check.
    expect(parseArgs(['--subagent-session-id', 's', '--ipc=0']).ok).toBe(false);
    expect(parseArgs(['--subagent-session-id', 's', '--ipc=-1']).ok).toBe(false);
    expect(parseArgs(['--subagent-session-id', 's', '--ipc=foo']).ok).toBe(false);
    expect(parseArgs(['--subagent-session-id', 's', '--ipc=1.5']).ok).toBe(false);
    expect(parseArgs(['--subagent-session-id', 's', '--ipc=']).ok).toBe(false);
  });

  test('rejects --ipc without --subagent-session-id (would otherwise silently strip from prompt)', () => {
    // `--ipc` is an INTERNAL flag the parent appends to child
    // argv. Operators typing `agent --ipc=1 "fix the bug"`
    // would have it silently consumed (no IPC channel actually
    // wired in non-subagent mode); a prompt fragment starting
    // with `--ipc=...` would be unexpectedly stripped from the
    // user's input. Reject loudly so the misconfiguration
    // surfaces at parse time.
    const r1 = parseArgs(['--ipc=1']);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.message).toContain('--subagent-session-id');

    const r2 = parseArgs(['--ipc']);
    expect(r2.ok).toBe(false);

    const r3 = parseArgs(['--ipc=2', 'fix', 'the', 'bug']);
    expect(r3.ok).toBe(false);
  });

  test('absent by default — child runs in legacy SQLite-only mode', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentIpcVersion).toBeUndefined();
  });

  test('coexists with other internal subagent flags', () => {
    // Concurrent flag presence is the realistic invocation:
    // `agent --subagent-session-id <id> --subagent-depth 1
    //  --ipc=1`. Each flag captures into its own field; no
    // ordering coupling.
    const r = parseArgs(['--subagent-session-id', 'sess-x', '--subagent-depth', '2', '--ipc=1']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentSessionId).toBe('sess-x');
    expect(r.args.subagentDepth).toBe(2);
    expect(r.args.subagentIpcVersion).toBe(1);
  });
});

describe('--worktrees', () => {
  test('captures verb + positionals', () => {
    const r = parseArgs(['--worktrees', 'gc', '--dry-run']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.worktrees?.verb).toBe('gc');
    expect(r.args.worktrees?.positionals).toEqual(['--dry-run']);
  });

  test('list verb takes no positionals', () => {
    const r = parseArgs(['--worktrees', 'list']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.worktrees?.verb).toBe('list');
    expect(r.args.worktrees?.positionals).toEqual([]);
  });

  test('rejects when verb is missing', () => {
    expect(parseArgs(['--worktrees']).ok).toBe(false);
  });

  test('rejects unknown verb', () => {
    expect(parseArgs(['--worktrees', 'sneeze']).ok).toBe(false);
  });

  test('stops positional collection at top-level flags', () => {
    // --json is a top-level flag, must NOT be swallowed as a
    // gc positional. --dry-run / --force ARE gc sub-flags.
    const r = parseArgs(['--worktrees', 'gc', '--dry-run', '--json']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.worktrees?.positionals).toEqual(['--dry-run']);
    expect(r.args.json).toBe(true);
  });

  test('regression: --yes after gc is NOT swallowed as positional', () => {
    // Before the verb-aware allowlist fix, --yes / --model / any
    // top-level flag past `gc` got swallowed into positionals,
    // silently disappearing from the run. Now those flags break
    // the gc capture and reach the outer parser. --yes parses
    // into args.yes; gc.positionals contains only its own
    // sub-flags.
    const r = parseArgs(['--worktrees', 'gc', '--dry-run', '--yes']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.worktrees?.positionals).toEqual(['--dry-run']);
    expect(r.args.yes).toBe(true);
  });

  test('regression: --model after list is NOT swallowed', () => {
    // list has no sub-flags, so any flag-shaped token breaks
    // the positional collection immediately. --model becomes
    // available for the outer parser to handle.
    const r = parseArgs(['--worktrees', 'list', '--model', 'mock/m']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.worktrees?.positionals).toEqual([]);
    expect(r.args.model).toBe('mock/m');
  });

  test('list with unknown sub-flag breaks capture instead of swallowing', () => {
    // --bogus is not a gc sub-flag and list has none. Capture
    // stops; --bogus reaches the outer parser, which rejects
    // it as unknown.
    const r = parseArgs(['--worktrees', 'list', '--bogus']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--bogus');
  });
});

describe('--subagent-memory-cwd', () => {
  test('captures the path value', () => {
    const r = parseArgs(['--subagent-session-id', 'abc', '--subagent-memory-cwd', '/repo/parent']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.subagentMemoryCwd).toBe('/repo/parent');
  });

  test('rejects flag-shaped values', () => {
    const r = parseArgs(['--subagent-memory-cwd', '--subagent-depth', '2']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--subagent-memory-cwd');
  });

  test('rejects empty value', () => {
    const r = parseArgs(['--subagent-memory-cwd', '']);
    expect(r.ok).toBe(false);
  });
});

describe('--memory', () => {
  test('captures verb + scope positional for list', () => {
    const r = parseArgs(['--memory', 'list', 'user']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memory?.verb).toBe('list');
    expect(r.args.memory?.positionals).toEqual(['user']);
  });

  test('captures verb + name + scope for show', () => {
    const r = parseArgs(['--memory', 'show', 'role', 'project_local']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memory?.verb).toBe('show');
    expect(r.args.memory?.positionals).toEqual(['role', 'project_local']);
  });

  test('list with no positionals is valid', () => {
    const r = parseArgs(['--memory', 'list']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memory?.positionals).toEqual([]);
  });

  test('rejects when verb is missing', () => {
    const r = parseArgs(['--memory']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--memory');
  });

  test('rejects unknown verb', () => {
    expect(parseArgs(['--memory', 'sneeze']).ok).toBe(false);
  });

  test('stops positional collection at top-level flag', () => {
    const r = parseArgs(['--memory', 'show', 'role', '--json']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memory?.positionals).toEqual(['role']);
    expect(r.args.json).toBe(true);
  });
});

// Slice 123 (R9 P1): pre-slice `agent --i-know-what-im-doing`
// (without the `welcome` verb) silently parsed `iKnowWhatImDoing:
// true`, but the flag is only read inside the welcome branch in
// run.ts — so the top-level form was a no-op that LOOKED like
// it acknowledged unsafe-mode. Now the top-level parser rejects
// with a pointer to the correct invocation.
describe('--i-know-what-im-doing top-level rejection (slice 123, R9 P1)', () => {
  test('agent --i-know-what-im-doing (no welcome) returns error pointing at `agent welcome`', () => {
    const r = parseArgs(['--i-know-what-im-doing']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--i-know-what-im-doing');
    expect(r.message).toContain('agent welcome');
  });

  test('agent welcome --i-know-what-im-doing still parses successfully', () => {
    // The welcome subcommand parser is separate from the top-level
    // parser and continues to accept the flag (slice 91 contract).
    const r = parseArgs(['welcome', '--i-know-what-im-doing']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.welcome).toBe(true);
    expect(r.args.iKnowWhatImDoing).toBe(true);
  });

  test('agent --i-know-what-im-doing with other flags before still rejects', () => {
    // Even when the flag appears alongside otherwise-valid flags,
    // the top-level form is invalid.
    const r = parseArgs(['--json', '--i-know-what-im-doing', 'hello']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('agent welcome');
  });
});

// Welcome subcommand detection is anchored to argv[0]. An earlier
// cut scanned the entire argv for the literal word `welcome` to
// accommodate `agent --i-know-what-im-doing welcome` (welcome
// after a flag) — but that regression-broke prompts containing
// the word `welcome` as plain text, mis-routing them into the
// welcome subcommand and erroring on unknown flags.
describe('welcome subcommand detection — argv[0] only (review fix)', () => {
  test('agent --json welcome → prompt is "welcome" with --json (NOT welcome subcommand)', () => {
    const r = parseArgs(['--json', 'welcome']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.welcome).toBeUndefined();
    expect(r.args.json).toBe(true);
    expect(r.args.prompt).toBe('welcome');
  });

  test('agent hello welcome world → prompt is "hello welcome world"', () => {
    const r = parseArgs(['hello', 'welcome', 'world']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.welcome).toBeUndefined();
    expect(r.args.prompt).toBe('hello welcome world');
  });

  test('agent "welcome to forja" → prompt contains welcome verbatim', () => {
    // Shell-quoted single positional. argv[0] is the whole prompt,
    // not the literal token `welcome`, so no subcommand match.
    const r = parseArgs(['welcome to forja']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.welcome).toBeUndefined();
    expect(r.args.prompt).toBe('welcome to forja');
  });

  test('agent welcome → IS the welcome subcommand', () => {
    // Sanity check: the canonical form still works (argv[0] match).
    const r = parseArgs(['welcome']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.welcome).toBe(true);
  });

  test('agent welcome --help → welcome subcommand with help flag', () => {
    const r = parseArgs(['welcome', '--help']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.help).toBe(true);
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
    expect(u).toContain('init');
  });
});

describe('parseArgs — init subcommand', () => {
  test('bare `init` produces strict-mode init descriptor', () => {
    const r = parseArgs(['init']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.init).toEqual({ force: false, mode: 'strict', playbooks: false });
    expect(r.args.prompt).toBe('');
  });

  test('--force flips the force bit', () => {
    const r = parseArgs(['init', '--force']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.init?.force).toBe(true);
  });

  test('--mode acceptEdits is accepted', () => {
    const r = parseArgs(['init', '--mode', 'acceptEdits']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.init?.mode).toBe('acceptEdits');
  });

  test('--mode bypass is rejected (init never scaffolds bypass)', () => {
    const r = parseArgs(['init', '--mode', 'bypass']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('strict|acceptEdits');
  });

  test('--mode without value is rejected', () => {
    const r = parseArgs(['init', '--mode']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--mode requires a value');
  });

  test('unknown init flag is rejected with init scope', () => {
    const r = parseArgs(['init', '--bogus']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('init: unknown argument');
  });

  test('--playbooks switches the init mode flag', () => {
    const r = parseArgs(['init', '--playbooks']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.init).toEqual({ force: false, mode: 'strict', playbooks: true });
  });

  test('--playbooks composes with --force', () => {
    const r = parseArgs(['init', '--playbooks', '--force']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.init).toEqual({ force: true, mode: 'strict', playbooks: true });
  });

  test('--playbooks ignores the irrelevant --mode flag without erroring', () => {
    // Mode is a permissions concept; on the playbooks path the
    // handler does not consult it. Erroring on the combination
    // would be operator-hostile (`agent init --mode strict
    // --playbooks` is plausible muscle memory).
    const r = parseArgs(['init', '--mode', 'acceptEdits', '--playbooks']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.init).toEqual({ force: false, mode: 'acceptEdits', playbooks: true });
  });

  test('init only triggers as the FIRST positional', () => {
    // `agent "review init"` should pass through as a regular prompt;
    // the operator must be able to use the literal word 'init' in
    // free-form prompts.
    const r = parseArgs(['review', 'init']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.init).toBeUndefined();
    expect(r.args.prompt).toBe('review init');
  });

  test('init --help routes to top-level help (no separate help text)', () => {
    const r = parseArgs(['init', '--help']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.help).toBe(true);
  });
});

describe('parseArgs — recap subcommand', () => {
  test('bare `recap` collects no args', () => {
    const r = parseArgs(['recap']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.recap).toEqual({ args: [] });
    expect(r.args.json).toBe(false);
  });

  test('positional and flags forward verbatim to the recap surface', () => {
    const r = parseArgs(['recap', 'pr', '--no-llm-render', '--out', 'PR.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.recap?.args).toEqual(['pr', '--no-llm-render', '--out', 'PR.md']);
  });

  test('--json toggles NDJSON event mode (consumed at subcommand boundary)', () => {
    const r = parseArgs(['recap', '--json', 'pr']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.json).toBe(true);
    // --json is NOT forwarded to the recap-side parser (it's the
    // headless event-stream toggle, not a renderer flag).
    expect(r.args.recap?.args).toEqual(['pr']);
  });

  test('--help short-circuits to help mode', () => {
    const r = parseArgs(['recap', '--help']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.help).toBe(true);
  });

  test('preserves recap-specific flags including --since DATE', () => {
    const r = parseArgs(['recap', 'list', '--since', '2026-05-01', '--limit', '50']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.recap?.args).toEqual(['list', '--since', '2026-05-01', '--limit', '50']);
  });

  test('--model <id> is consumed at top-level, not forwarded to recap args', () => {
    // Regression: pre-fix `--model` was forwarded into recap args
    // and the slash-side parser rejected it as an unknown flag,
    // making model selection for `agent recap` impossible despite
    // run() honoring args.model when bootstrapping the provider.
    const r = parseArgs(['recap', 'pr', '--model', 'anthropic/claude-haiku-4-5']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.model).toBe('anthropic/claude-haiku-4-5');
    // --model + value extracted from the forwarded args.
    expect(r.args.recap?.args).toEqual(['pr']);
  });

  test('--model=<id> single-token form also extracts to args.model', () => {
    const r = parseArgs(['recap', 'pr', '--model=anthropic/claude-haiku-4-5']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.model).toBe('anthropic/claude-haiku-4-5');
    expect(r.args.recap?.args).toEqual(['pr']);
  });

  test('--model without a value is a parse error', () => {
    const r = parseArgs(['recap', '--model']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--model requires a value');
  });

  test('--model with a flag-shaped value is a parse error (no silent swallow)', () => {
    // Same defense as the slash-side parsers: refuse `--model
    // --json` so the operator's intended toggle isn't silently
    // consumed as the model id.
    const r = parseArgs(['recap', '--model', '--json']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--model requires a value');
  });

  test('--sandbox-host is a presence-only flag (slice 10 §6.5)', () => {
    const r = parseArgs(['--sandbox-host']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.sandboxHost).toBe(true);
  });

  test('--sandbox-host absent leaves the field undefined (default off)', () => {
    const r = parseArgs([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.sandboxHost).toBeUndefined();
  });
});

describe('--broker (§13.7 mode flag, slice 87)', () => {
  test('--broker spawn sets brokerMode to "spawn"', () => {
    const r = parseArgs(['--broker', 'spawn']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.brokerMode).toBe('spawn');
  });

  test('--broker in-process sets brokerMode to "in-process"', () => {
    const r = parseArgs(['--broker', 'in-process']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.brokerMode).toBe('in-process');
  });

  test('--broker absent leaves brokerMode undefined (bootstrap defaults to in-process)', () => {
    const r = parseArgs([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.brokerMode).toBeUndefined();
  });

  test('--broker with no value is rejected', () => {
    const r = parseArgs(['--broker']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--broker requires a mode');
  });

  test('--broker with a flag-shaped next token is rejected', () => {
    const r = parseArgs(['--broker', '--yes']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--broker requires a mode');
  });

  test('--broker with an unknown mode is rejected with the offending value', () => {
    const r = parseArgs(['--broker', 'magic']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("'in-process' or 'spawn'");
    expect(r.message).toContain('magic');
  });

  // ── S11 review (F12 + flag plumbing) ────────────────────────────

  test('--memory-verify-llm parses as a presence-only opt-in', () => {
    const r = parseArgs(['--memory-verify-llm', 'do', 'thing']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryVerifyLlm).toBe(true);
    expect(r.args.prompt).toBe('do thing');
  });

  test('--memory-verify-llm defaults to undefined when omitted', () => {
    const r = parseArgs(['hello']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryVerifyLlm).toBeUndefined();
  });

  test('--memory-verify-llm with --subagent-session-id is rejected (F12)', () => {
    const r = parseArgs(['--subagent-session-id', 'child-id', '--memory-verify-llm', 'hello']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--memory-verify-llm');
    expect(r.message).toContain('--subagent-session-id');
  });

  // ── S13 flag plumbing (parallel to F12 mirror) ──────────────────

  test('--memory-conflict-llm parses as a presence-only opt-in', () => {
    const r = parseArgs(['--memory-conflict-llm', 'do', 'thing']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryConflictLlm).toBe(true);
    expect(r.args.prompt).toBe('do thing');
  });

  test('--memory-conflict-llm defaults to undefined when omitted', () => {
    const r = parseArgs(['hello']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryConflictLlm).toBeUndefined();
  });

  test('--memory-conflict-llm with --subagent-session-id is rejected', () => {
    const r = parseArgs(['--subagent-session-id', 'child-id', '--memory-conflict-llm', 'hi']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--memory-conflict-llm');
    expect(r.message).toContain('--subagent-session-id');
  });

  test('--memory-verify-llm + --memory-conflict-llm coexist (independent flags)', () => {
    const r = parseArgs(['--memory-verify-llm', '--memory-conflict-llm', 'go']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryVerifyLlm).toBe(true);
    expect(r.args.memoryConflictLlm).toBe(true);
  });

  // ── Slice Q: --no-* flags + mutual-exclusion ────────────────────

  test('--no-memory-verify-llm parses as explicit off (false, not undefined)', () => {
    const r = parseArgs(['--no-memory-verify-llm', 'hello']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryVerifyLlm).toBe(false);
  });

  test('--no-memory-conflict-llm parses as explicit off', () => {
    const r = parseArgs(['--no-memory-conflict-llm', 'hello']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryConflictLlm).toBe(false);
  });

  test('omission → undefined (no CLI override; config layer resolves)', () => {
    const r = parseArgs(['just a prompt']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryVerifyLlm).toBeUndefined();
    expect(r.args.memoryConflictLlm).toBeUndefined();
  });

  test('--memory-verify-llm + --no-memory-verify-llm are mutually exclusive', () => {
    const r = parseArgs(['--memory-verify-llm', '--no-memory-verify-llm', 'x']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('mutually exclusive');
    expect(r.message).toContain('--memory-verify-llm');
  });

  test('--memory-conflict-llm + --no-memory-conflict-llm are mutually exclusive', () => {
    const r = parseArgs(['--memory-conflict-llm', '--no-memory-conflict-llm', 'x']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('mutually exclusive');
    expect(r.message).toContain('--memory-conflict-llm');
  });

  test('--no-memory-verify-llm + --subagent-session-id is also rejected (F12 mirror)', () => {
    const r = parseArgs(['--subagent-session-id', 'child', '--no-memory-verify-llm', 'x']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--memory-verify-llm');
    expect(r.message).toContain('--subagent-session-id');
  });

  test('--no-memory-conflict-llm + --subagent-session-id is rejected', () => {
    const r = parseArgs(['--subagent-session-id', 'child', '--no-memory-conflict-llm', 'x']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--memory-conflict-llm');
  });

  // S3.5 — --memory-override-llm / --no-memory-override-llm
  test('--memory-override-llm parses as explicit on', () => {
    const r = parseArgs(['--memory-override-llm', 'hello']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryOverrideLlm).toBe(true);
  });

  test('--no-memory-override-llm parses as explicit off', () => {
    const r = parseArgs(['--no-memory-override-llm', 'hello']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryOverrideLlm).toBe(false);
  });

  test('--memory-override-llm + --no-memory-override-llm are mutually exclusive', () => {
    const r = parseArgs(['--memory-override-llm', '--no-memory-override-llm', 'x']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('mutually exclusive');
    expect(r.message).toContain('--memory-override-llm');
  });

  test('--no-memory-override-llm + --subagent-session-id is rejected (F12 mirror)', () => {
    const r = parseArgs(['--subagent-session-id', 'child', '--no-memory-override-llm', 'x']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--memory-override-llm');
    expect(r.message).toContain('--subagent-session-id');
  });

  test('omission of override flag → undefined', () => {
    const r = parseArgs(['just a prompt']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.memoryOverrideLlm).toBeUndefined();
  });
});
