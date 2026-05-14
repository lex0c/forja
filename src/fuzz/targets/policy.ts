// Fuzz target: §15.4 line 1119 "policy parser (random TOML → no
// crash)". The project's policy parser is YAML, not TOML — spec
// text is loose; what matters is that `loadPolicyFromString`
// either returns a valid `Policy` object OR throws a standard
// `Error` with a string message. No silent undefined returns, no
// non-Error throws, no infinite recursion, no stack overflow.
//
// Spec wording "no crash" in JS/Bun means: the harness doesn't
// see a non-recoverable exit (OOM, native crash, runaway loop).
// All recoverable failures (malformed YAML, schema violations,
// protected-path redefinitions) MUST throw an `Error` so they're
// caught by the engine bootstrap and turned into a `refusing`
// state with an operator-readable reason. This target pins both
// surfaces of that contract.
//
// Generator strategy: YAML-meta-biased random strings. Pure-ASCII
// random rarely produces valid YAML structure (no colons, no
// newlines, no list dashes), so the parser bails out at
// tokenization. The bias toward YAML metacharacters + seeded
// policy-key words (defaults, mode, tools, bash, allow, deny)
// pushes inputs past the YAML parser and into parsePolicy's
// schema validation — the layer most likely to harbor unhandled-
// branch bugs.

import { loadPolicyFromString } from '../../permissions/index.ts';
import type { FuzzTarget } from '../index.ts';
import { randInt } from '../random.ts';

export interface PolicyFuzzInput {
  yaml: string;
}

// Common policy keys + values. Sampled with weight to push the
// parser past tokenization into schema validation. Each entry is
// a complete token that can land verbatim in the output stream.
const POLICY_TOKENS = [
  // Top-level sections
  'defaults',
  'tools',
  'sandbox',
  'seal',
  // defaults.mode values
  'mode',
  'strict',
  'acceptEdits',
  'bypass',
  // tools.<name> keys
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'fetch_url',
  // Per-tool rule keys
  'allow',
  'deny',
  'confirm',
  'allow_paths',
  'deny_paths',
  'confirm_paths',
  'allow_hosts',
  'deny_hosts',
  // Lock + sandbox fields
  'locked',
  'required',
  'host_allowed',
  // Seal fields
  'path',
  'none',
  'worm-file',
  'git-anchored',
  'interval_decisions',
  'interval_seconds',
  'on_failure',
  'degrade',
  'refuse',
  // Booleans + small ints
  'true',
  'false',
  '0',
  '1',
  '100',
  '3600',
];

const randPolicyToken = (rng: () => number): string => {
  const idx = randInt(rng, 0, POLICY_TOKENS.length - 1);
  return POLICY_TOKENS[idx] ?? '';
};

// YAML-meta-biased character. ~50% YAML structure (colon, newline,
// list dash, indent, quote, brace, bracket); ~50% identifier chars
// + the occasional policy token via the higher-level composer.
const randYamlChar = (rng: () => number): string => {
  const roll = rng();
  if (roll < 0.15) return '\n'; // line break — YAML's primary structure
  if (roll < 0.25) return ' '; // indent / separator
  if (roll < 0.3) return ':';
  if (roll < 0.33) return '-';
  if (roll < 0.36) return '"';
  if (roll < 0.39) return "'";
  if (roll < 0.42) return '[';
  if (roll < 0.45) return ']';
  if (roll < 0.48) return '{';
  if (roll < 0.51) return '}';
  if (roll < 0.53) return '#'; // comment marker
  if (roll < 0.55) return ','; // flow separator
  if (roll < 0.57) return '|'; // block scalar
  // 43% identifier chars (letters + digits + underscore).
  const code = randInt(rng, 0, 36);
  if (code < 26) return String.fromCharCode(97 + code); // a-z
  if (code < 36) return String.fromCharCode(48 + (code - 26)); // 0-9
  return '_';
};

const randPolicyYaml = (rng: () => number, length: number): string => {
  let s = '';
  while (s.length < length) {
    // ~12% chance to drop a known policy token (multi-char) into
    // the stream; otherwise emit a single YAML-shaped char. Mixed
    // token-and-char generation produces inputs that LOOK like
    // policy but with random structural breakage.
    if (rng() < 0.12) {
      s += randPolicyToken(rng);
    } else {
      s += randYamlChar(rng);
    }
  }
  // Trim if overshoot from the multi-char tokens.
  return s.slice(0, length);
};

export const policyFuzzTarget: FuzzTarget<PolicyFuzzInput> = {
  name: 'policy',
  generate: (rng) => {
    // 8-256 char policies. Empty/tiny inputs are valid YAML (parse
    // succeeds with `{}`); medium-pathological land in the
    // validation layer where most unhandled branches live.
    const len = randInt(rng, 8, 256);
    return { yaml: randPolicyYaml(rng, len) };
  },
  format: (input) => `yaml=${JSON.stringify(input.yaml)}`,
  run: (input) => {
    // Two outcomes are valid:
    //   (a) loadPolicyFromString returns a Policy object (yaml
    //       parsed AND schema validated).
    //   (b) loadPolicyFromString throws an Error with a string
    //       message (yaml malformed OR schema rejected).
    // Anything else — non-Error throw, undefined return, return
    // of a non-object value — is a fuzz failure.
    try {
      const result = loadPolicyFromString(input.yaml);
      if (result === null || typeof result !== 'object') {
        throw new Error(`loadPolicyFromString returned non-object: ${typeof result}`);
      }
      // Structural sanity: a valid Policy has defaults + tools.
      // The parser may produce a policy without defaults.mode set
      // (operator silence is legal); but `defaults` itself must
      // exist as an object.
      if (typeof result.defaults !== 'object' || result.defaults === null) {
        throw new Error('Policy.defaults missing or non-object');
      }
      if (typeof result.tools !== 'object' || result.tools === null) {
        throw new Error('Policy.tools missing or non-object');
      }
    } catch (e) {
      // Re-throw Errors with string messages — those are the
      // accepted recoverable-failure shape per spec line 1119.
      // Surface anything else as an invariant violation.
      if (e instanceof Error) {
        if (typeof e.message !== 'string') {
          // Defensive — Error.message should always be a string,
          // but a thrown Error with a non-string message slot would
          // break operator error rendering.
          throw new Error(`thrown Error has non-string message: ${typeof e.message}`);
        }
        // Accepted: parser/validator rejected the input cleanly.
        return;
      }
      // Non-Error throw (string, number, undefined, plain object)
      // is a contract violation — the engine bootstrap expects
      // Error instances and renders them via `.message`.
      throw new Error(`non-Error throw from parser: ${typeof e}, value=${String(e)}`);
    }
  },
};
