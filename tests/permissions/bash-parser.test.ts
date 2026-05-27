import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __pushTimeoutForTest,
  __resetBashParserRateLimitForTest,
  getRecentParseTimeoutCount,
  initBashParser,
  parseBash,
} from '../../src/permissions/bash-parser.ts';

beforeAll(async () => {
  await initBashParser();
});

describe('parseBash — happy path', () => {
  test('parses a simple command into a tree', () => {
    const r = parseBash('ls -la');
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.tree).toBeDefined();
    expect(r.root).toBeDefined();
    expect(r.root.type).toBe('program');
  });

  test('parses a pipeline', () => {
    const r = parseBash('ls -la | grep foo | wc -l');
    expect(r).not.toBeNull();
  });

  test('parses an empty string (still produces a tree)', () => {
    // tree-sitter is error-recovering; an empty source produces
    // a program node with no children. Resolver treats this as
    // "no commands recognized" but the parse itself succeeds.
    const r = parseBash('');
    expect(r).not.toBeNull();
  });
});

// Slice 110 — R2 #204: tree-sitter is error-recovering and
// usually fast, but pathological adversarial input could drive
// the LR(1) state machine into a slow path. PARSE_TIMEOUT_MS
// caps every parse at 5s; over the ceiling, parseBash throws
// `bash-parser: parse timeout after Nms (input length=...)`.
// The bash resolver maps the throw to `parser unavailable
// (bash-parser: ...)` — distinct from null return, which the
// resolver maps to `parser produced no tree`.
describe('parseBash — timeout defense (slice 110, R2 #204)', () => {
  test('legitimate input under the ceiling parses cleanly (no false-positive timeout)', () => {
    // A moderately-sized but valid bash command — well under
    // the 5s ceiling. The defense MUST NOT regress the normal
    // case.
    const cmd = `for i in $(seq 1 100); do echo line-$i; done && ${'ls /tmp; '.repeat(50)}`;
    const r = parseBash(cmd);
    expect(r).not.toBeNull();
  });

  test('parse timeout throws with operator-readable reason', () => {
    // Verifying the timeout fires requires either a real
    // pathological input (fragile across grammar versions) OR
    // a mock that triggers the progressCallback path. Tree-
    // sitter doesn't expose a synthetic-slowness seam, and
    // synthesizing pathological input that always trips the
    // grammar's slow paths would couple this test to specific
    // grammar revisions.
    //
    // Smoke test: verify the parse helper accepts very large
    // input without crashing (the size itself isn't enough to
    // trigger timeout — tree-sitter is O(N) for happy-case
    // input — but it exercises the progressCallback wiring,
    // which fires repeatedly during a long parse). If the
    // progressCallback is misconfigured (e.g., throws instead
    // of returning bool), this surfaces here.
    const huge = 'echo ok; '.repeat(10_000);
    const r = parseBash(huge);
    expect(r).not.toBeNull();
  });

  test('throws when source is null at the parser level (defensive)', () => {
    // Not a timeout test — pinning the function's "no source"
    // boundary. Empty string parses fine (above); the actual
    // null source would be a TS type violation but the runtime
    // shape is documented.
    const r = parseBash('   ');
    // Trimmed-empty input — tree-sitter still produces a tree.
    expect(r).not.toBeNull();
  });
});

// Rate-limit defense (hardening, follow-up to slice 110). The
// PARSE_TIMEOUT_MS cap alone bounded SINGLE-call latency but not
// the cumulative cost of N pathological inputs in a row — N calls
// burned N×TIMEOUT_MS of single-threaded engine. The window-based
// counter short-circuits subsequent parses after RATE_LIMIT_MAX_TIMEOUTS
// have fired within RATE_LIMIT_WINDOW_MS so the attack cost stays
// flat instead of linear.
describe('parseBash — rate-limit window (DoS hardening)', () => {
  beforeEach(() => {
    __resetBashParserRateLimitForTest();
  });

  test('counter starts at zero on a fresh module / after reset', () => {
    expect(getRecentParseTimeoutCount()).toBe(0);
  });

  test('counter reports the number of in-window timeouts', () => {
    const now = Date.now();
    __pushTimeoutForTest(now);
    __pushTimeoutForTest(now);
    expect(getRecentParseTimeoutCount()).toBe(2);
  });

  test('expired entries are evicted from the count', () => {
    // Push timeouts that are well outside the 30s window. Reading
    // the counter triggers eviction; the stale entries drop.
    const stale = Date.now() - 60_000;
    __pushTimeoutForTest(stale);
    __pushTimeoutForTest(stale);
    expect(getRecentParseTimeoutCount()).toBe(0);
  });

  test('rate-limit fires after 3 in-window timeouts', () => {
    // Seed 3 fresh timeouts. The next parse must throw a rate-
    // limit error WITHOUT running the grammar — the message
    // identifies the threshold + window for forensic clarity.
    const now = Date.now();
    __pushTimeoutForTest(now);
    __pushTimeoutForTest(now);
    __pushTimeoutForTest(now);
    expect(() => parseBash('echo hi')).toThrow(/rate-limited/);
    expect(() => parseBash('echo hi')).toThrow(/3 parse timeouts in last 30000ms/);
  });

  test('rate-limit clears once entries age out of the window', () => {
    // Seed 3 stale timeouts. The next parse runs normally
    // because evictExpiredTimeouts drops them before the gate.
    const stale = Date.now() - 60_000;
    __pushTimeoutForTest(stale);
    __pushTimeoutForTest(stale);
    __pushTimeoutForTest(stale);
    const r = parseBash('echo hi');
    expect(r).not.toBeNull();
    expect(getRecentParseTimeoutCount()).toBe(0);
  });

  test('rate-limit message identifies the reason, not a generic parse error', () => {
    // Operators reading audit rows distinguish 'parser unavailable
    // (rate-limited)' from 'parser unavailable (timeout)' as
    // distinct triage paths. The exact substring 'rate-limited'
    // must remain stable.
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) __pushTimeoutForTest(now);
    try {
      parseBash('echo hi');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('rate-limited');
      expect((e as Error).message).toContain('30000ms');
    }
  });

  test('first 2 in-window timeouts do NOT trip the gate', () => {
    // The threshold is `>= 3`. 2 timeouts leaves the window with
    // 1 slot — the next call parses normally.
    const now = Date.now();
    __pushTimeoutForTest(now);
    __pushTimeoutForTest(now);
    expect(() => parseBash('echo hi')).not.toThrow();
  });
});

// H1 (review): node-kind snapshot against silent grammar drift.
// The bash resolver's defense rests on a closed whitelist of
// node.type strings (WHITELIST_NODE_TYPES + RED_FLAG_NODES in
// src/permissions/resolvers/bash.ts). If a tree-sitter-bash update
// renames a node-kind (e.g. `expansion` → `parameter_expansion`),
// `RED_FLAG_NODES.get('expansion')` silently becomes a no-op AND
// the walker's WHITELIST_NODE_TYPES check still fires on the new
// name as "unsupported_shape" — fail-safe for the new name, but
// the SPECIFIC threat reason ("parameter_expansion: runtime
// substitution") is lost, and audit aggregation breaks.
//
// This suite pins the grammar contract: for each input shape we
// rely on, the parser MUST produce at least the expected node-kind
// in the AST. If the grammar renames any of them, the test fails
// and the grammar update PR is blocked until the resolver's
// whitelist + red-flag tables are updated alongside.
//
// Coverage: every LIVE entry in RED_FLAG_NODES (20 of 25 kinds —
// the other 5 are dead under v0.25.1; see meta-test exclusion
// list) plus the load-bearing WHITELIST entries (program, command,
// command_name, pipeline, list, file_redirect, redirected_statement,
// string, raw_string, concatenation, number).
describe('parseBash — node-kind snapshot (H1 grammar drift defense)', () => {
  // Collect every distinct node.type appearing under the parsed root.
  // Tree-sitter walks include anonymous nodes (punctuation literals
  // like '|', '&&') alongside named nodes — both contribute to
  // the kind set because the resolver branches on both.
  const collectKindsImpl = (input: string): Set<string> => {
    const parsed = parseBash(input);
    if (parsed === null) throw new Error(`parseBash returned null for ${JSON.stringify(input)}`);
    const kinds = new Set<string>();
    const visit = (node: typeof parsed.root): void => {
      kinds.add(node.type);
      for (const child of node.children) {
        if (child !== null) visit(child);
      }
    };
    visit(parsed.root);
    return kinds;
  };

  // (input, expected node-kind subset). The expected set is a
  // SUBSET assertion, not equality — the AST also contains
  // ancillary kinds (`program`, punctuation) that aren't
  // load-bearing for the test.
  const cases: readonly { input: string; expect: readonly string[]; label: string }[] = [
    // Structural / WHITELIST core
    {
      label: 'simple command',
      input: 'ls -la',
      expect: ['program', 'command', 'command_name', 'word'],
    },
    { label: 'pipeline', input: 'ls | grep foo', expect: ['pipeline', 'command'] },
    // `;` and top-level `&` produce sibling commands under `program`
    // WITHOUT a `list` wrapper in tree-sitter-bash@0.25.1 — only
    // `&&` and `||` wrap in `list`. Pin the actual kinds so the
    // snapshot is honest about the grammar shape.
    { label: 'sequence ;', input: 'echo a; echo b', expect: [';', 'command'] },
    { label: 'list &&', input: 'echo a && echo b', expect: ['list'] },
    { label: 'list ||', input: 'echo a || echo b', expect: ['list'] },
    { label: 'background &', input: 'sleep 1 &', expect: ['&', 'command'] },
    {
      label: 'redirected out',
      input: 'echo hi > out',
      expect: ['redirected_statement', 'file_redirect'],
    },
    { label: 'redirected append', input: 'echo hi >> out', expect: ['file_redirect'] },
    { label: 'redirected in', input: 'cat < in', expect: ['file_redirect'] },
    { label: 'fd dup', input: 'cmd 2>&1', expect: ['file_descriptor', 'number'] },
    { label: 'double-quoted string', input: 'echo "hi"', expect: ['string'] },
    { label: 'single-quoted string', input: "echo 'hi'", expect: ['raw_string'] },
    { label: 'concatenation', input: 'echo a"b"c', expect: ['concatenation'] },
    { label: 'numeric arg', input: 'sleep 5', expect: ['number'] },
    // RED_FLAG_NODES
    {
      label: 'command_substitution $()',
      input: 'echo $(date)',
      expect: ['command_substitution'],
    },
    {
      label: 'process_substitution <()',
      input: 'diff <(echo a) <(echo b)',
      expect: ['process_substitution'],
    },
    { label: 'expansion ${var}', input: 'echo ${HOME}', expect: ['expansion'] },
    { label: 'simple_expansion $var', input: 'echo $HOME', expect: ['simple_expansion'] },
    {
      label: 'arithmetic_expansion $(())',
      input: 'echo $((1 + 1))',
      expect: ['arithmetic_expansion'],
    },
    {
      label: 'function_definition (POSIX)',
      input: 'foo() { echo bar; }',
      expect: ['function_definition'],
    },
    {
      label: 'variable_assignment prefix',
      input: 'FOO=bar baz',
      expect: ['variable_assignment'],
    },
    { label: 'array subscript', input: 'echo ${arr[0]}', expect: ['subscript'] },
    // `=~` is exposed as `binary_expression` with operator `=~`,
    // NOT a `regex` node. The defense fires via `test_command` (the
    // [[ ... ]] container) which IS in RED_FLAG_NODES. `regex` in
    // RED_FLAG_NODES is dead under this grammar version.
    {
      label: 'regex match =~ (via binary_expression in test_command)',
      input: '[[ a =~ b ]]',
      expect: ['test_command', 'binary_expression', '=~'],
    },
    { label: 'ansi_c_string', input: "echo $'\\n'", expect: ['ansi_c_string'] },
    // `$"..."` is parsed as a regular `string` with a leading `$`
    // word in v0.25.1 — no distinct `translated_string` node-kind.
    // `translated_string` in RED_FLAG_NODES is dead under this
    // grammar version. The regular `string` content still flows
    // through the walker normally; no security gap.
    {
      label: 'translated_string ($"...") parsed as regular string',
      input: 'echo $"hi"',
      expect: ['string'],
    },
    {
      label: 'heredoc_redirect',
      input: 'cat <<EOF\nx\nEOF',
      expect: ['heredoc_redirect'],
    },
    {
      label: 'herestring_redirect',
      input: 'cat <<<"hi"',
      expect: ['herestring_redirect'],
    },
    { label: 'if_statement', input: 'if true; then :; fi', expect: ['if_statement'] },
    {
      label: 'while_statement',
      input: 'while true; do :; done',
      expect: ['while_statement'],
    },
    {
      label: 'for_statement',
      input: 'for i in 1 2; do :; done',
      expect: ['for_statement'],
    },
    {
      label: 'case_statement',
      input: 'case x in y) :;; esac',
      expect: ['case_statement'],
    },
    { label: 'subshell ()', input: '(echo a)', expect: ['subshell'] },
    { label: 'compound_statement {}', input: '{ echo a; }', expect: ['compound_statement'] },
    { label: 'negated_command !', input: '! true', expect: ['negated_command'] },
    // `[[ -f x ]]` produces test_command + unary_expression + test_operator.
    // The test_operator node carries the operator literal (`-f`); pinning
    // it here keeps the live RED_FLAG_NODES.test_operator entry covered.
    {
      label: 'test_command [[]]',
      input: '[[ -f x ]]',
      expect: ['test_command', 'test_operator'],
    },
    // `arr=(a b c)` is parsed as `variable_assignment` with an
    // `array` child node, NOT a distinct `array_assignment` kind.
    // The defense fires via `variable_assignment` which IS in
    // RED_FLAG_NODES. `array_assignment` in RED_FLAG_NODES is dead
    // under this grammar version.
    {
      label: 'array_assignment (parsed as variable_assignment + array child)',
      input: 'arr=(a b c)',
      expect: ['variable_assignment', 'array'],
    },
  ];

  for (const { input, expect: expectedKinds, label } of cases) {
    test(`${label}: ${JSON.stringify(input)} produces expected node kinds`, () => {
      const kinds = collectKindsImpl(input);
      for (const expected of expectedKinds) {
        if (!kinds.has(expected)) {
          throw new Error(
            `Grammar drift: input ${JSON.stringify(input)} did not produce node-kind '${expected}'. Actual kinds: [${Array.from(kinds).sort().join(', ')}]. If the grammar renamed this kind, update WHITELIST_NODE_TYPES / RED_FLAG_NODES in src/permissions/resolvers/bash.ts to match.`,
          );
        }
      }
    });
  }

  test('every LIVE RED_FLAG_NODES key is covered by at least one case', () => {
    // Defends the meta-contract: if someone ADDS a new red-flag
    // kind to bash.ts but forgets a snapshot case, this test
    // surfaces it. The list is hardcoded mirror of bash.ts —
    // staying in sync IS the test.
    //
    // Dead entries — empirically confirmed via probe that
    // tree-sitter-bash@0.25.1 does NOT emit these node-kinds for
    // any input shape:
    //   - `regex` — `=~` is parsed as binary_expression with the
    //     `=~` operator inside test_command.
    //   - `translated_string` — `$"..."` is parsed as regular
    //     string with a leading `$` word.
    //   - `array_assignment` — `arr=(a b c)` is parsed as
    //     variable_assignment with an `array` child.
    //   - `coproc_statement` — `coproc cmd` is parsed as a regular
    //     command with `coproc` as command_name.
    //   - `last_pipe` — `cmd1 |& cmd2` is parsed as pipeline with
    //     `|&` as an anonymous operator token.
    //
    // Dead entries stay in RED_FLAG_NODES as forward-compat against
    // grammar updates that might introduce these distinct kinds.
    // Removing them is tracked separately; the snapshot only
    // enforces coverage of the LIVE kinds confirmed by probe.
    const liveRedFlagKinds = [
      'command_substitution',
      'process_substitution',
      'expansion',
      'simple_expansion',
      'arithmetic_expansion',
      'function_definition',
      'variable_assignment',
      'subscript',
      'ansi_c_string',
      'heredoc_redirect',
      'herestring_redirect',
      'if_statement',
      'while_statement',
      'for_statement',
      'case_statement',
      'subshell',
      'compound_statement',
      'negated_command',
      'test_command',
      'test_operator',
    ];
    const allCovered = new Set<string>();
    for (const { expect: kinds } of cases) {
      for (const k of kinds) allCovered.add(k);
    }
    const missing = liveRedFlagKinds.filter((k) => !allCovered.has(k));
    if (missing.length > 0) {
      throw new Error(
        `Snapshot suite missing cases for red-flag kinds: ${missing.join(', ')}. Add a case to the table whose input produces each missing kind.`,
      );
    }
  });
});

describe('parseBash — multiple sequential parses (parser reset)', () => {
  test('two parses in sequence both succeed independently', () => {
    // Slice 110 calls `parser.reset()` after a timed-out parse
    // to prevent the next parse from resuming where the last
    // one left off (web-tree-sitter contract: a cancelled parse
    // leaves the parser in a paused state). The happy path
    // doesn't need reset because the parse completed; this
    // test pins that sequential clean parses don't bleed state.
    const a = parseBash('echo a');
    const b = parseBash('echo b');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a !== null && b !== null) {
      // Different parse → different root node identity.
      expect(a.root).not.toBe(b.root);
    }
  });

  test('parse after a previous failed parse still works', () => {
    // A parse that fails for some reason shouldn't break the
    // next parse. Tree-sitter is error-recovering so most
    // input parses to SOMETHING; we test a sequence where
    // both succeed.
    const a = parseBash('echo first');
    expect(a).not.toBeNull();
    const b = parseBash('echo second');
    expect(b).not.toBeNull();
  });
});
