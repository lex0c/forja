// Retrieval compression (RETRIEVAL.md §6).
//
// Greedy budget allocation over a four-level representation
// hierarchy: `full` → `outline` → `summary` → `ref`. Top-K tries
// `full` first; tail degrades down the hierarchy as the remaining
// token budget shrinks. Candidates whose cheapest level
// (typically `ref`) doesn't fit land on the skipped trail with a
// `wouldCostTokens` hint so the operator (or model) can ask for
// expansion or raise budget.
//
// Spec §6.2 algorithm — verbatim:
//
//   remaining = budget
//   for c in ranked:
//     for level in [full, outline, summary, ref]:
//       if cost(c, level) <= remaining:
//         include(c, level)
//         remaining -= cost(c, level)
//         break
//     else:
//       skip(c)
//
// Per-view resolvers materialize the actual content for each
// level. Memory view reads via MemoryRegistry; session view reads
// from the three session repos (messages / tool_calls /
// failure_events). Workspace deferred with slice 4.4.
//
// Token cost is a single per-content estimate today
// (`Math.ceil(len / 4)`). Per-provider token-precise counting can
// inject via the `estimateTokens` dep — slice 4.9 (integration)
// wires that from the active provider's `countTokens` when
// available.

import type { MemoryRegistry, MemoryScope } from '../memory/index.ts';
import type { DB } from '../storage/db.ts';
import { getFailureEvent } from '../storage/repos/failure-events.ts';
import { getMessage } from '../storage/repos/messages.ts';
import { getToolCall } from '../storage/repos/tool-calls.ts';
import type {
  CompressionLevel,
  ContextSlot,
  ContextSlotEntry,
  RankedCandidate,
  RetrievalQuery,
  RetrievalView,
  SkippedCandidate,
} from './types.ts';

// Ordered cheapest-content-wins → cheapest-cost-wins. The greedy
// loop steps down this list per candidate.
const TRY_LEVELS: CompressionLevel[] = ['full', 'outline', 'summary', 'ref'];

// Heuristic token estimator. ~4 chars/token is the canonical
// rule-of-thumb across modern tokenizers — close enough for v1
// budget bookkeeping. Minimum 1 so an empty string still consumes
// a slot (the slot's existence is informational; the trace
// records "this candidate was placed at level=summary even though
// summary collapsed to empty").
const defaultEstimateTokens = (content: string): number =>
  Math.max(1, Math.ceil(content.length / 4));

export interface ResolvedContent {
  // Materialized payload at the requested level.
  content: string;
  // Token cost as measured by the active estimator.
  costTokens: number;
}

// Per-view resolver. Returns null when the (candidate, level)
// pair has no content to produce (e.g., the underlying row was
// deleted between rank and compress, or the view doesn't support
// this level). The greedy loop falls through to the next level.
export interface CompressionResolver {
  resolve(candidate: RankedCandidate, level: CompressionLevel): ResolvedContent | null;
}

export interface CompressionResolverDeps {
  // Required for the memory view resolver.
  registry: MemoryRegistry;
  // Required for the session view resolver.
  db: DB;
  // Optional token estimator override. Defaults to the chars/4
  // heuristic; slice 4.9 wires provider-specific counters here.
  estimateTokens?: (content: string) => number;
}

// Pull readable text from a message's content payload (same shape
// the session view handles — arrays of Anthropic content blocks,
// plain strings, legacy objects). Mirror of `messageText` in the
// session view; kept local to avoid a cross-module export of a
// helper that's small enough to copy.
const messageText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const obj = block as Record<string, unknown>;
      if (typeof obj.text === 'string') {
        parts.push(obj.text);
        continue;
      }
      if (typeof obj.content === 'string') {
        parts.push(obj.content);
        continue;
      }
      if (obj.input !== undefined) {
        parts.push(JSON.stringify(obj.input));
        continue;
      }
      parts.push(JSON.stringify(obj));
    }
    return parts.join(' ');
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
};

// Parse a `memory:<scope>/<name>` node id. Returns null on
// malformed input (defensive — view always emits the well-formed
// shape, but a corrupt trace replay could feed garbage). The
// scope is validated against the canonical MemoryScope enum here
// so a corrupted nodeId with an unknown scope (`memory:made_up/x`)
// is refused at parse time instead of bypassing the registry's
// own validation later.
const VALID_MEMORY_SCOPES: ReadonlySet<MemoryScope> = new Set([
  'user',
  'project_shared',
  'project_local',
]);

const isMemoryScope = (s: string): s is MemoryScope => VALID_MEMORY_SCOPES.has(s as MemoryScope);

const parseMemoryNodeId = (nodeId: string): { scope: MemoryScope; name: string } | null => {
  const prefix = 'memory:';
  if (!nodeId.startsWith(prefix)) return null;
  const rest = nodeId.slice(prefix.length);
  const slash = rest.lastIndexOf('/');
  if (slash < 0) return null;
  const scope = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (scope.length === 0 || name.length === 0) return null;
  if (!isMemoryScope(scope)) return null;
  return { scope, name };
};

// Parse a `session:<kind>:<id>` node id where kind ∈
// { message, tool_call, failure }. Returns null on malformed.
const parseSessionNodeId = (
  nodeId: string,
): { kind: 'message' | 'tool_call' | 'failure'; id: string } | null => {
  const prefix = 'session:';
  if (!nodeId.startsWith(prefix)) return null;
  const rest = nodeId.slice(prefix.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) return null;
  const kind = rest.slice(0, firstColon);
  const id = rest.slice(firstColon + 1);
  if (id.length === 0) return null;
  if (kind !== 'message' && kind !== 'tool_call' && kind !== 'failure') return null;
  return { kind, id };
};

// Truncate to roughly N tokens by chars/4 heuristic. The token
// count after truncation may overshoot slightly (estimator rounds
// up); compress's outer loop checks against budget so the final
// allocation is honest.
const truncateToApproxTokens = (s: string, tokens: number): string => {
  const targetChars = tokens * 4;
  if (s.length <= targetChars) return s;
  return `${s.slice(0, targetChars)}…`;
};

const memoryResolver = (
  registry: MemoryRegistry,
  candidate: RankedCandidate,
  level: CompressionLevel,
  estimate: (s: string) => number,
): ResolvedContent | null => {
  const parsed = parseMemoryNodeId(candidate.nodeId);
  if (parsed === null) return null;

  if (level === 'ref') {
    const content = `memory:${parsed.scope}/${parsed.name}`;
    return { content, costTokens: estimate(content) };
  }

  // full / outline / summary all need the file body. Use
  // `registry.peek` (not `read`) — compression is an internal
  // pipeline step that may probe several levels per candidate
  // before placement and may drop the candidate entirely if no
  // level fits the remaining budget. Emitting `memory_events`
  // `action=read` here would flood the audit log with synthetic
  // reads that don't correspond to anything the model actually
  // saw. The retrieval-side audit lives in `retrieval_trace`
  // (included nodeIds + skipped trail), which is the right
  // surface for "this memory was served via retrieve_context".
  // `memory_events action=read` stays reserved for explicit
  // `memory_read` tool calls — the model asking by name. `peek`
  // gives the same scope-pinned lookup semantics, just without
  // the audit side effect.
  const result = registry.peek(parsed.name, { scope: parsed.scope });
  if (result.kind !== 'present') return null;
  const file = result.file;

  if (level === 'summary') {
    const content = file.frontmatter.description;
    return { content, costTokens: estimate(content) };
  }

  if (level === 'outline') {
    // Frontmatter metadata + first 5 lines of body. Gives the
    // model a structural skim without committing the full body
    // budget. The em-dash separator matches the index format
    // operators see in MEMORY.md.
    const head = file.body.split('\n').slice(0, 5).join('\n');
    const content = `${file.frontmatter.name} — ${file.frontmatter.description}\n\n${head}`;
    return { content, costTokens: estimate(content) };
  }

  // full
  const content = `${file.frontmatter.name} — ${file.frontmatter.description}\n\n${file.body}`;
  return { content, costTokens: estimate(content) };
};

const sessionResolver = (
  db: DB,
  candidate: RankedCandidate,
  level: CompressionLevel,
  estimate: (s: string) => number,
): ResolvedContent | null => {
  const parsed = parseSessionNodeId(candidate.nodeId);
  if (parsed === null) return null;

  if (level === 'ref') {
    const content = candidate.nodeId;
    return { content, costTokens: estimate(content) };
  }

  if (parsed.kind === 'message') {
    const msg = getMessage(db, parsed.id);
    if (msg === null) return null;
    const text = messageText(msg.content);
    if (level === 'summary') {
      const firstLine = text.split('\n', 1)[0] ?? '';
      const content = `[${msg.role}] ${truncateToApproxTokens(firstLine, 20)}`;
      return { content, costTokens: estimate(content) };
    }
    if (level === 'outline') {
      const content = `[${msg.role}]\n${truncateToApproxTokens(text, 200)}`;
      return { content, costTokens: estimate(content) };
    }
    // full
    const content = `[${msg.role}] ${text}`;
    return { content, costTokens: estimate(content) };
  }

  if (parsed.kind === 'tool_call') {
    const tc = getToolCall(db, parsed.id);
    if (tc === null) return null;
    const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
    if (level === 'summary') {
      const content = `${tc.toolName}(${truncateToApproxTokens(inputStr, 15)})`;
      return { content, costTokens: estimate(content) };
    }
    if (level === 'outline') {
      const content = `tool=${tc.toolName} status=${tc.status}\ninput=${truncateToApproxTokens(inputStr, 100)}`;
      return { content, costTokens: estimate(content) };
    }
    // full — include output when present so the model can read
    // the actual result body. Tool outputs CAN be large; the
    // greedy loop has a chance to demote to outline if `full`
    // costs more than remaining budget.
    const outputStr =
      tc.output === null
        ? '<no output>'
        : typeof tc.output === 'string'
          ? tc.output
          : JSON.stringify(tc.output);
    const errorLine = tc.error !== null ? `error: ${tc.error}\n` : '';
    const content = `tool=${tc.toolName} status=${tc.status}\ninput=${inputStr}\n${errorLine}output=${outputStr}`;
    return { content, costTokens: estimate(content) };
  }

  if (parsed.kind === 'failure') {
    const fe = getFailureEvent(db, parsed.id);
    if (fe === null) return null;
    if (level === 'summary') {
      const content = `${fe.classe}/${fe.code}`;
      return { content, costTokens: estimate(content) };
    }
    if (level === 'outline') {
      const content = `failure=${fe.code} classe=${fe.classe} recovery=${fe.recovery_action}`;
      return { content, costTokens: estimate(content) };
    }
    // full
    const payload = fe.payload_json ?? '{}';
    const content = `failure=${fe.code} classe=${fe.classe} recovery=${fe.recovery_action}\npayload=${payload}`;
    return { content, costTokens: estimate(content) };
  }

  // Unreachable: parseSessionNodeId enforces the kind enum.
  return null;
};

const VIEW_HAS_NO_RESOLVER = new Set<RetrievalView>(['workspace']);

export const createCompressionResolver = (deps: CompressionResolverDeps): CompressionResolver => {
  const estimate = deps.estimateTokens ?? defaultEstimateTokens;
  return {
    resolve(candidate, level) {
      if (VIEW_HAS_NO_RESOLVER.has(candidate.view)) {
        // Workspace view deferred with slice 4.4. Returning null
        // skips the candidate; the greedy loop logs it under
        // skipped with reason="no level resolver".
        return null;
      }
      if (candidate.view === 'memory') {
        return memoryResolver(deps.registry, candidate, level, estimate);
      }
      if (candidate.view === 'session') {
        return sessionResolver(deps.db, candidate, level, estimate);
      }
      return null;
    },
  };
};

export interface CompressGreedyInput {
  ranked: readonly RankedCandidate[];
  query: RetrievalQuery;
  resolver: CompressionResolver;
}

// Greedy budget allocator. Returns a ContextSlot the pipeline
// hands to CONTEXT_TUNING (the consumer that decides positioning;
// retrieval owns selection + compression only).
//
// Trace stability: candidates are placed / skipped in the order
// they arrive (ranked descending). Two candidates of equal final
// score were already tie-broken in the ranker (nodeId ASC) so the
// order is deterministic.
export const compressGreedy = (input: CompressGreedyInput): ContextSlot => {
  const included: ContextSlotEntry[] = [];
  const skipped: SkippedCandidate[] = [];
  let remaining = input.query.budgetTokens;

  for (const c of input.ranked) {
    let placed = false;
    // Track the cheapest level we tried but couldn't fit so the
    // skipped entry can carry the operator hint "would have
    // cost X tokens".
    let cheapestUnfit: { level: CompressionLevel; cost: number } | null = null;

    for (const level of TRY_LEVELS) {
      const resolved = input.resolver.resolve(c, level);
      if (resolved === null) continue;
      // Guard against malformed cost output. `estimateTokens` is
      // an injectable hook (slice 4.9 wires provider-specific
      // token counters here); a buggy override returning NaN /
      // Infinity / negative would otherwise corrupt the greedy
      // comparison silently — `NaN <= remaining` is `false`, so
      // the candidate would skip THIS level and try the next one
      // without surfacing the breakage, and a placed Infinity
      // would underflow `remaining`. Treat the level as
      // not-resolvable (same as `null`) and fall through; the
      // skipped trail will reflect the cheapest valid level.
      if (!Number.isFinite(resolved.costTokens) || resolved.costTokens < 0) {
        process.stderr.write(
          `forja retrieval: resolver returned invalid costTokens ${resolved.costTokens} for ${c.view}/${c.nodeId} @ ${level}; treating as unresolvable\n`,
        );
        continue;
      }
      if (resolved.costTokens <= remaining) {
        included.push({
          nodeId: c.nodeId,
          view: c.view,
          level,
          content: resolved.content,
          costTokens: resolved.costTokens,
        });
        remaining -= resolved.costTokens;
        placed = true;
        break;
      }
      if (cheapestUnfit === null || resolved.costTokens < cheapestUnfit.cost) {
        cheapestUnfit = { level, cost: resolved.costTokens };
      }
    }

    if (!placed) {
      skipped.push({
        nodeId: c.nodeId,
        view: c.view,
        wouldCostTokens: cheapestUnfit?.cost ?? null,
        reason:
          cheapestUnfit !== null
            ? `cheapest level (${cheapestUnfit.level}) costs ${cheapestUnfit.cost}t > remaining ${remaining}t`
            : 'no resolver produced content for this candidate',
      });
    }
  }

  return { included, skipped };
};
