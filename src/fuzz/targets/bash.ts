// Fuzz target: §15.4 line 1118 "bash resolver (random shell
// snippets → no panic, sempre Conservative ou Refuse em casos
// esquisitos)". Exercises the bash resolver — tree-sitter-bash
// AST walk, whitelist matching, capability resolution — with
// adversarially-shaped command strings drawn from a bash-meta-
// biased distribution (slice 67).
//
// Invariants verified per iteration:
//   - The resolver returns a result with kind ∈ {ok, conservative,
//     refuse} — no throws escape the resolver.
//   - When kind=ok: capabilities is an array, confidence is one
//     of high|medium|low.
//   - When kind=conservative: capabilities is an array, reason
//     is a string.
//   - When kind=refuse: reason is a string.
//
// The spec doesn't require "weird inputs always refuse" — only
// that the resolver never panics + always produces a structurally
// valid result. Random ASCII frequently includes substrings the
// whitelist recognizes (e.g. `ls`, `pwd`), so ok results are
// expected and acceptable. The harness pins the SHAPE, not the
// decision.
//
// CALLER CONTRACT: `await initBashParser()` MUST be called before
// runFuzz with this target. The bash AST walker requires tree-
// sitter-bash to be loaded; the resolver itself catches parser-
// unavailable as a refuse, but the underlying parseBash relies on
// the WASM grammar being initialized. Tests call initBashParser
// in beforeAll; CI nightly runners do the same in their setup.

import { getResolver } from '../../permissions/resolvers/registry.ts';
import type { FuzzTarget } from '../index.ts';
import { randInt } from '../random.ts';

export interface BashFuzzInput {
  command: string;
}

// Bash-meta-biased character distribution. Emphasizes shell
// operators (pipe, redirect, expansion), quote chars, and common
// command-word leading letters. Pure-ASCII random rarely produces
// realistic shell structure; the bias triggers parser branches
// for quoting, command substitution, redirects, and word-boundary
// edge cases.
const randBashChar = (rng: () => number): string => {
  const roll = rng();
  // ~50% shell metacharacters distributed across the grammar's
  // major operator classes.
  if (roll < 0.05) return ' '; // whitespace
  if (roll < 0.1) return '|'; // pipe / or
  if (roll < 0.13) return '&'; // background / and
  if (roll < 0.16) return ';'; // sequence
  if (roll < 0.19) return '$'; // variable / arithmetic expansion
  if (roll < 0.22) return '(';
  if (roll < 0.25) return ')';
  if (roll < 0.28) return '{';
  if (roll < 0.31) return '}';
  if (roll < 0.34) return '"';
  if (roll < 0.37) return "'";
  if (roll < 0.4) return '`'; // command substitution (backtick)
  if (roll < 0.43) return '<'; // redirect in
  if (roll < 0.46) return '>'; // redirect out
  if (roll < 0.49) return '\\'; // escape
  if (roll < 0.55) return '/'; // path separator
  // Seed real-looking command starts to push the resolver past
  // the tokenizer and into the whitelist walk.
  if (roll < 0.58) return 'l'; // ls / less
  if (roll < 0.61) return 's'; // sh / sed / sort
  if (roll < 0.64) return 'c'; // cat / cd / cp / curl
  // Fall through to broader printable ASCII for variety.
  return String.fromCharCode(randInt(rng, 32, 126));
};

const randBashCommand = (rng: () => number, length: number): string => {
  let s = '';
  for (let i = 0; i < length; i++) s += randBashChar(rng);
  return s;
};

export const bashFuzzTarget: FuzzTarget<BashFuzzInput> = {
  name: 'bash',
  generate: (rng) => {
    // 1-96 char commands cover empty-ish, single-token, and
    // medium-pathological inputs. Larger sizes blow up wall-
    // clock per iteration without surfacing new branches.
    const len = randInt(rng, 1, 96);
    return { command: randBashCommand(rng, len) };
  },
  format: (input) => `command=${JSON.stringify(input.command)}`,
  run: (input) => {
    const resolver = getResolver('bash');
    if (resolver === undefined) {
      throw new Error('bashFuzzTarget: bash resolver not registered');
    }
    // ResolverContext.home is unused by the bash resolver's
    // capability emission (paths come from positional args), but
    // the interface requires it. Use realistic-looking defaults.
    // `suppressDegradeWarnings` keeps the M3 warn-once stderr
    // message out of fuzz-loop output — the target deliberately
    // omits realpath/readlink, no symlink-aware classification
    // needed for the structural invariants this target pins.
    const ctx = { cwd: '/work/proj', home: '/home/op', suppressDegradeWarnings: true };
    const result = resolver({ command: input.command }, ctx);

    if (result.kind !== 'ok' && result.kind !== 'conservative' && result.kind !== 'refuse') {
      throw new Error(`unknown result kind: ${String((result as { kind: unknown }).kind)}`);
    }
    if (result.kind === 'ok') {
      if (!Array.isArray(result.capabilities)) {
        throw new Error('ok result missing capabilities array');
      }
      if (
        result.confidence !== 'high' &&
        result.confidence !== 'medium' &&
        result.confidence !== 'low'
      ) {
        throw new Error(`ok result has invalid confidence: ${String(result.confidence)}`);
      }
    }
    if (result.kind === 'conservative') {
      if (!Array.isArray(result.capabilities)) {
        throw new Error('conservative result missing capabilities array');
      }
      if (typeof result.reason !== 'string') {
        throw new Error('conservative result missing reason string');
      }
    }
    if (result.kind === 'refuse') {
      if (typeof result.reason !== 'string') {
        throw new Error('refuse result missing reason string');
      }
    }
  },
};
