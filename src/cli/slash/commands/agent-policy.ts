// /agent policy — operator-facing inspection + lifecycle for
// adaptation policies (FEEDBACK_ADAPTATION §3.2 + §9.3).
//
// Subcommands:
//   /agent policy                          summary (count by state)
//   /agent policy list [state]             list proposed/active/etc.
//   /agent policy promote <id>             proposed → active
//   /agent policy invalidate <id> [motivo] active → invalidated
//   /agent policy history <id>             walk parent_id chain
//   /agent policy run [scope]              fire loop frio manually
//
// Reads from the `policies` table populated by the loop frio
// (3.4). Until the L1 alias dispatch (3.5) ships, promoted
// policies are visible but don't change behavior — operators can
// inspect proposals, promote what they like, and see the audit
// trail without committing to dispatch-time rewriting.

import { runLoopFrio } from '../../../feedback/loop-frio.ts';
import {
  IllegalPolicyTransitionError,
  type Policy,
  type PolicyState,
  getPolicy,
  listPoliciesByActionSignature,
  listPoliciesByState,
  listPolicyHistory,
  transitionPolicy,
} from '../../../storage/repos/policies.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

const POLICY_STATES_OPERATOR: PolicyState[] = [
  'proposed',
  'active',
  'shadow',
  'quarantined',
  'invalidated',
];

const formatStats = (p: Policy): string => {
  if (p.ciLow === null || p.ciHigh === null) return `n=${p.n}`;
  return `n=${p.n} ci=[${p.ciLow.toFixed(3)},${p.ciHigh.toFixed(3)}]`;
};

const formatPolicyLine = (p: Policy): string => {
  const idShort = p.id.slice(0, 8);
  const motivo = p.motivo !== null ? ` motivo=${p.motivo}` : '';
  return `  ${idShort} · ${p.state.padEnd(11)} · ${p.scopeKind}/${p.scopeId} · ${p.actionSignature} · ${formatStats(p)}${motivo}`;
};

const handleSummary = (ctx: SlashContext): SlashResult => {
  const counts: Record<PolicyState, number> = {
    proposed: 0,
    active: 0,
    shadow: 0,
    quarantined: 0,
    invalidated: 0,
  };
  for (const state of POLICY_STATES_OPERATOR) {
    counts[state] = listPoliciesByState(ctx.db, state).length;
  }
  const total = Object.values(counts).reduce((sum, v) => sum + v, 0);
  if (total === 0) {
    return {
      kind: 'ok',
      notes: [
        'no adaptation policies registered yet',
        'subcommands: list · promote · invalidate · history · run',
      ],
    };
  }
  return {
    kind: 'ok',
    notes: [
      `policies (${total} total):`,
      `  proposed: ${counts.proposed}  active: ${counts.active}  shadow: ${counts.shadow}`,
      `  quarantined: ${counts.quarantined}  invalidated: ${counts.invalidated}`,
      'subcommands: list · promote · invalidate · history · run',
    ],
  };
};

const handleList = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length > 1) {
    return {
      kind: 'error',
      message: `/agent policy list: too many args (got ${args.length}, expected 0 or 1 state)`,
    };
  }
  if (args.length === 1) {
    const state = args[0] as PolicyState;
    if (!POLICY_STATES_OPERATOR.includes(state)) {
      return {
        kind: 'error',
        message: `/agent policy list: invalid state '${state}' (expected: ${POLICY_STATES_OPERATOR.join(', ')})`,
      };
    }
    const rows = listPoliciesByState(ctx.db, state);
    if (rows.length === 0) {
      return { kind: 'ok', notes: [`no policies in state '${state}'`] };
    }
    const lines = [`policies in state '${state}' (${rows.length}):`];
    for (const p of rows) lines.push(formatPolicyLine(p));
    return { kind: 'ok', notes: lines };
  }

  // No state filter — list everything grouped by state.
  const lines: string[] = [];
  for (const state of POLICY_STATES_OPERATOR) {
    const rows = listPoliciesByState(ctx.db, state);
    if (rows.length === 0) continue;
    lines.push(`${state} (${rows.length}):`);
    for (const p of rows) lines.push(formatPolicyLine(p));
  }
  if (lines.length === 0) {
    return { kind: 'ok', notes: ['no adaptation policies registered yet'] };
  }
  return { kind: 'ok', notes: lines };
};

const handlePromote = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length === 0) {
    return {
      kind: 'error',
      message: '/agent policy promote: missing policy id (use /agent policy list to find it)',
    };
  }
  const id = args[0] as string;
  // Allow short-id prefix matching when the operator passes the
  // 8-char abbreviation from /agent policy list output. Walk all
  // policies and find one whose id startsWith the supplied prefix;
  // refuse on ambiguity.
  const resolved = resolvePolicyId(ctx, id);
  if (resolved.kind === 'error') return resolved;

  try {
    const updated = transitionPolicy(ctx.db, resolved.id, 'active', 'operator_promote', ctx.now());
    if (updated === null) {
      return { kind: 'error', message: `/agent policy promote: policy ${resolved.id} not found` };
    }
    return {
      kind: 'ok',
      notes: [
        `promoted ${resolved.id.slice(0, 8)} → active`,
        `  ${updated.scopeKind}/${updated.scopeId} · ${updated.actionSignature}`,
      ],
    };
  } catch (err) {
    if (err instanceof IllegalPolicyTransitionError) {
      return {
        kind: 'error',
        message: `/agent policy promote: illegal transition ${err.from} → ${err.to} (only 'proposed' policies can be promoted)`,
      };
    }
    throw err;
  }
};

const handleInvalidate = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length === 0) {
    return { kind: 'error', message: '/agent policy invalidate: missing policy id' };
  }
  const id = args[0] as string;
  const motivo = args.length >= 2 ? args.slice(1).join(' ') : 'operator_invalidate';
  const resolved = resolvePolicyId(ctx, id);
  if (resolved.kind === 'error') return resolved;

  try {
    const updated = transitionPolicy(ctx.db, resolved.id, 'invalidated', motivo, ctx.now());
    if (updated === null) {
      return {
        kind: 'error',
        message: `/agent policy invalidate: policy ${resolved.id} not found`,
      };
    }
    return {
      kind: 'ok',
      notes: [
        `invalidated ${resolved.id.slice(0, 8)} (motivo: ${motivo})`,
        `  ${updated.scopeKind}/${updated.scopeId} · ${updated.actionSignature}`,
      ],
    };
  } catch (err) {
    if (err instanceof IllegalPolicyTransitionError) {
      return {
        kind: 'error',
        message: `/agent policy invalidate: illegal transition ${err.from} → ${err.to}`,
      };
    }
    throw err;
  }
};

const handleHistory = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length === 0) {
    return { kind: 'error', message: '/agent policy history: missing policy id' };
  }
  const id = args[0] as string;
  const resolved = resolvePolicyId(ctx, id);
  if (resolved.kind === 'error') return resolved;

  const chain = listPolicyHistory(ctx.db, resolved.id);
  if (chain.length === 0) {
    return { kind: 'error', message: `/agent policy history: policy ${resolved.id} not found` };
  }
  const lines = [`policy chain (${chain.length} entries, oldest first):`];
  for (const p of chain) lines.push(formatPolicyLine(p));
  return { kind: 'ok', notes: lines };
};

const handleRun = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length > 0) {
    return {
      kind: 'error',
      message: `/agent policy run: extra args (got ${args.length}); scope filtering not yet supported`,
    };
  }
  const result = runLoopFrio({ db: ctx.db, now: ctx.now });
  const lines: string[] = [
    `loop frio considered ${result.considered} (action_signature, scope) tuples:`,
  ];
  lines.push(`  proposed: ${result.proposed.length}`);
  lines.push(`  rejected: ${result.rejected.length}`);
  if (result.proposed.length > 0) {
    lines.push('proposed policies:');
    for (const p of result.proposed) {
      lines.push(`  ${p.policy.id.slice(0, 8)} · ${p.actionSignature} · ${formatStats(p.policy)}`);
    }
  }
  if (result.rejected.length > 0) {
    lines.push('rejected:');
    for (const r of result.rejected) {
      lines.push(`  ${r.actionSignature} · ${r.kind}`);
    }
  }
  return { kind: 'ok', notes: lines };
};

// Resolve a full-id or short-prefix to a single policy id. Returns
// error on no-match or ambiguous match. Same UX pattern git uses for
// commit hashes.
type ResolvedId = { kind: 'ok'; id: string } | { kind: 'error'; message: string };

const resolvePolicyId = (ctx: SlashContext, idOrPrefix: string): ResolvedId => {
  // Full-id fast path.
  if (idOrPrefix.length >= 32) {
    const full = getPolicy(ctx.db, idOrPrefix);
    if (full === null) {
      return { kind: 'error', message: `/agent policy: policy ${idOrPrefix} not found` };
    }
    return { kind: 'ok', id: idOrPrefix };
  }
  // Short-prefix: scan ALL states for a unique startsWith match.
  // Tradeoff: O(N) per resolution, but N (policies) is small.
  const all: Policy[] = [];
  for (const state of POLICY_STATES_OPERATOR) {
    all.push(...listPoliciesByState(ctx.db, state));
  }
  // Sort matches by id so the ambiguity error message is stable
  // across runs — without sorting, the order reflects state-group
  // iteration + per-state recorded_at, which can flip between
  // sessions. Operators relying on the listed prefix to disambiguate
  // got non-reproducible enumerations.
  const matches = all
    .filter((p) => p.id.startsWith(idOrPrefix))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (matches.length === 0) {
    return { kind: 'error', message: `/agent policy: no policy matches prefix '${idOrPrefix}'` };
  }
  if (matches.length > 1) {
    const ids = matches
      .slice(0, 5)
      .map((p) => p.id.slice(0, 8))
      .join(', ');
    return {
      kind: 'error',
      message: `/agent policy: prefix '${idOrPrefix}' is ambiguous (${matches.length} matches: ${ids}...); use full id`,
    };
  }
  const onlyMatch = matches[0];
  if (onlyMatch === undefined) {
    return { kind: 'error', message: `/agent policy: no match for '${idOrPrefix}'` };
  }
  return { kind: 'ok', id: onlyMatch.id };
};

// Future read-extension: list policies by (action_signature, scope).
// Not yet wired into a subcommand because the spec doesn't surface
// that view at the operator level — operators query by state most of
// the time, then drill into specific signatures via inspection tools.
export { listPoliciesByActionSignature };

export const agentPolicyCommand: SlashCommand = {
  name: 'agent',
  description:
    'manage adaptation policies (subcommands: policy list, promote, invalidate, history, run)',
  exec: async (args, ctx): Promise<SlashResult> => {
    // /agent <sub> ... — only `policy` subnamespace ships in 3.4.
    if (args.length === 0 || args[0] !== 'policy') {
      return {
        kind: 'error',
        message: "/agent: only 'policy' subnamespace is implemented (try /agent policy)",
      };
    }
    const tail = args.slice(1);
    const sub = tail[0];
    if (sub === undefined) return handleSummary(ctx);
    switch (sub) {
      case 'list':
        return handleList(ctx, tail.slice(1));
      case 'promote':
        return handlePromote(ctx, tail.slice(1));
      case 'invalidate':
        return handleInvalidate(ctx, tail.slice(1));
      case 'history':
        return handleHistory(ctx, tail.slice(1));
      case 'run':
        return handleRun(ctx, tail.slice(1));
      default:
        return {
          kind: 'error',
          message: `/agent policy: unknown subcommand '${sub}' (try: list, promote, invalidate, history, run)`,
        };
    }
  },
};
