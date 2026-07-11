// L1 alias dispatch rewrite (FEEDBACK_ADAPTATION §9.1 — first
// manifestação).
//
// Closes the loop end-to-end for L1 aliases:
//
//   1. Loop quente (3.2 + 3.5a) writes outcomes per bash dispatch,
//      including `alias:<from>:<to>` for known L1 binaries.
//   2. Loop frio (3.4) aggregates Beta posteriors and proposes
//      policies when ci_low > 0.7 AND n >= 10.
//   3. Operator promotes via `/agent policy promote <id>`.
//   4. THIS MODULE — at tool dispatch time, consult the resolver
//      for the L1 signature derived from the current bash command;
//      if an active policy exists, rewrite the binary.
//
// Adaptation now manifests in behavior. Spec §0.6 anti-pattern
// (adapt on N=1) is structurally prevented by the loop frio's
// n >= 10 gate; the rewrite trusts that gate.
//
// Coexistence: the rewrite happens BEFORE permission engine + tool
// dispatch. The permission engine sees the REWRITTEN command —
// audit rows reflect what actually ran. The pre-rewrite command is
// captured in the rewrite audit row separately so forensic queries
// can compare intent (what model asked for) vs effective (what
// actually ran).

import type { DB } from '../storage/db.ts';
import { lookupBashAlias } from './bash-aliases.ts';
import {
  extractLeadingBinary,
  isValidBinaryReplacement,
  rewriteCommandBinary,
} from './bash-parser.ts';
import { type ScopeChain, resolveActivePolicy } from './scope-resolver.ts';

export interface DispatchRewriteResult {
  // True when the input was actually rewritten — caller mutates
  // tu.input.command and emits an audit signal. False = no
  // applicable policy found OR rewrite couldn't apply structurally.
  rewritten: boolean;
  // The new command string. Equal to `originalCommand` when
  // `rewritten === false`. Distinct field rather than null so
  // callers always have a value to substitute.
  command: string;
  // The L1 signature that drove the rewrite. Useful for the
  // audit row + the loop frio's success tally on this
  // particular adaptation. Null when no rewrite applied.
  appliedSignature: string | null;
  // The active policy id that drove the rewrite. Null when no
  // rewrite applied. Operators tracing "why did my grep get
  // rewritten?" follow this id back to /agent policy history.
  appliedPolicyId: string | null;
  // The scope the policy was matched at (session/repo/user/
  // language/global). Null when no rewrite applied.
  matchedScope: string | null;
}

// Attempt to rewrite a bash command via active L1 alias policies.
// Returns the original command when no policy applies; otherwise
// the rewritten command + metadata for audit.
//
// Cheap when no policies exist: a single resolver query per
// invocation that short-circuits via SQL when no match exists at
// any scope.
export const maybeRewriteBashCommand = (
  db: DB,
  command: string,
  chain: ScopeChain,
): DispatchRewriteResult => {
  const fallback: DispatchRewriteResult = {
    rewritten: false,
    command,
    appliedSignature: null,
    appliedPolicyId: null,
    matchedScope: null,
  };

  const binary = extractLeadingBinary(command);
  if (binary === null) return fallback;

  // Look up the canonical alias for this binary. If the binary
  // isn't in the known-aliases table, there's no L1 signature to
  // resolve a policy against — fall through. Bash invocations
  // outside the curated set aren't candidates for rewriting in
  // this slice.
  const alias = lookupBashAlias(binary);
  if (alias === null) return fallback;

  // Self-alias short-circuit (alias.from === alias.to): even if
  // a policy exists for this signature, the rewrite would be a
  // no-op. Skipping the resolver query saves a DB roundtrip on
  // every cat/awk/sed invocation (3 of the 5 curated entries are
  // self-aliases for telemetry, not adaptation).
  if (alias.from === alias.to) return fallback;

  const signature = `alias:${alias.from}:${alias.to}`;
  const resolved = resolveActivePolicy(db, signature, chain);
  if (resolved.kind !== 'found') return fallback;

  // Parse action_json to get the target binary. The proposer's
  // canonical shape is {target: '<binary>'}; degenerate values
  // (missing field, non-string) skip the rewrite. CRITICAL:
  // the target is then validated as a bare-binary name — a
  // poisoned action_json carrying shell metacharacters (e.g.,
  // `; rm -rf /` from a hostile policy import) would bypass the
  // permission engine since the engine sees the REWRITTEN
  // command. isValidBinaryReplacement refuses any character
  // outside `[A-Za-z0-9_+.-]` (no paths, no whitespace, no
  // shell metas, no quotes, no newlines).
  let target: string | null = null;
  try {
    const parsed = JSON.parse(resolved.policy.actionJson) as { target?: unknown };
    if (typeof parsed.target === 'string' && parsed.target.length > 0) {
      target = parsed.target;
    }
  } catch {
    // action_json malformed — caller-side bug. Skip rewrite.
    return fallback;
  }
  if (target === null) return fallback;
  if (!isValidBinaryReplacement(target)) {
    // Defensive: log + skip. A future structured audit row would
    // record this as a tamper signal; for now stderr surfaces it
    // so operators notice on the first occurrence.
    process.stderr.write(
      `forja adaptation: refused rewrite by policy ${resolved.policy.id} — target '${target}' is not a bare binary name (potential injection)\n`,
    );
    return fallback;
  }

  // Self-alias on the policy side (target === from): no rewrite
  // needed. The policy exists for tally purposes but doesn't
  // manifest at dispatch. Distinct from the alias-table check
  // above — this fires when the ALIAS pair is from!=to but the
  // operator promoted a policy whose target collapses back to
  // from (rare; defensive).
  if (target === alias.from) return fallback;

  const rewritten = rewriteCommandBinary(command, target);
  if (rewritten === null) return fallback;

  return {
    rewritten: true,
    command: rewritten,
    appliedSignature: signature,
    appliedPolicyId: resolved.policy.id,
    matchedScope: resolved.matchedScope,
  };
};
