// Memory view (RETRIEVAL.md §3.1 + §3.2).
//
// Source: MemoryRegistry. Edges (cross-view) and decay come online
// in later slices — this module owns ONLY candidate generation.
//
// Per spec §3.2:
//   - "Memory: BM25 sobre title/body + tag match."
//
// Field-weight policy (this view's choice, spec stays agnostic):
//   - title (memory name)         × 3
//   - description (`entry.hook`)  × 2
//   - body                        × 1   (only when loadBodies=true)
//
// Body loading is opt-in because it costs a disk read per memory.
// At session boot we want a fast eager-load of titles + descriptions;
// the model-facing `retrieve_context` tool can pass `loadBodies` when
// it wants deep coverage and accepts the latency.
//
// Tags — declared in spec §3.2 as a signal — are not on the
// `MemoryListing` shape today (frontmatter parses `tags:` but
// `IndexEntry` drops them). When tags land on the listing shape
// they'll fold into the weighted token stream alongside title +
// description.

import type { MemoryRegistry } from '../../memory/index.ts';
import { type BM25Document, createBM25Index, tokenize } from '../bm25.ts';
import type { ViewSearch } from '../pipeline.ts';
import type { Candidate, RetrievalQuery, RetrievalView } from '../types.ts';

const VIEW: RetrievalView = 'memory';

const TITLE_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 2;
const BODY_WEIGHT = 1;
const DEFAULT_LIMIT = 20;

// Stable node id format. `memory:<scope>/<name>` — scope-qualified
// so same-name memories across scopes (user/role + local/role)
// produce distinct ids. Mirrors the disambiguation pattern §15 uses
// for cross-store joins.
const memoryNodeId = (scope: string, name: string): string => `memory:${scope}/${name}`;

// Ranking penalty for quarantined memories (EVICTION §9.7,
// MEMORY.md §6.5.2). Multiplies the bootstrap score so the
// candidate still surfaces but ranks below active siblings with
// comparable match quality. 0.3 means a quarantined memory needs
// ~3.3× the raw match score to tie an active one — enough to
// suppress in routine queries, light enough that a very strong
// match still gets ranked.
//
// The penalty applies at bootstrap; downstream signals (structural,
// temporal, etc.) further scale the final score. The net effect:
// a quarantined memory with average match quality lands below
// active siblings; a quarantined memory with overwhelming match
// quality still surfaces (the operator's quarantine flag was a
// signal of "questionable", not "forbidden" — a model that asks
// the right query should still find it).
//
// Exported so tests can pin the exact value — a silent change
// to 0.25 / 0.5 would pass relative-ordering tests but shift the
// penalty's behavior, so the constant value itself is part of the
// behavioral contract.
export const QUARANTINED_PENALTY = 0.3;

export interface MemoryViewDeps {
  registry: MemoryRegistry;
  // When true, body content joins the BM25 corpus. Defaults to
  // false because each body is a disk read; toggle on for queries
  // where the operator/model needs deep-coverage (semantic /
  // precedent_lookup workflows).
  loadBodies?: boolean;
  // Top-K cap on candidates produced by this view. Spec doesn't
  // fix a number; 20 balances downstream rank cost with coverage
  // for a typical registry (dozens to low hundreds of memories).
  limit?: number;
}

export const createMemoryView = (deps: MemoryViewDeps): ViewSearch => ({
  // `_signal` is accepted to honor the ViewSearch contract but
  // intentionally ignored — this view is fully synchronous over
  // in-memory registry state, so there's nothing to cancel. The
  // pipeline's between-stage `checkAborted` is the real bail-out
  // path for sync views. IO-backed views (workspace, 4.4) will
  // actually plumb the signal into their subprocesses.
  async search(query: RetrievalQuery, _signal?: AbortSignal): Promise<Candidate[]> {
    const queryTokens = tokenize(query.text);
    if (queryTokens.length === 0) return [];

    const limit = deps.limit ?? DEFAULT_LIMIT;
    // Use post-dedup listings so a `local` override of a `shared`
    // name doesn't double-count tokens for what is one effective
    // memory at decision time. Spec §2.4 says local > shared > user
    // for resolution; the retrieval surface should reflect what the
    // model would actually see.
    //
    // Include `active` + `quarantined`, exclude unexpired only.
    // Spec EVICTION §9.7 and MEMORY.md §6.5.2: quarantined memories
    // stay VISIBLE to the model with a ranking penalty + visual
    // flag. The penalty (×QUARANTINED_PENALTY below) is applied at
    // candidate emission; the eager-prompt visual flag is rendered
    // by `cli/memory-prompt.ts`.
    //
    // Why visible at all: quarantining is a "model should know this
    // is questionable, not deny access". Hard-filtering would
    // mimic deletion semantics and break operator forensics
    // ("did the model see X when it produced Y?" requires X to
    // remain reachable). Penalty + flag gives the model the signal
    // without auto-erasure.
    //
    // `invalidated` / `evicted` / `purged` stay excluded — those
    // states ARE the deletion path. `includeExpired: false` keeps
    // past-date memories out (a hard filter, not a penalty —
    // expiration is operator-declared intent that the memory has
    // no validity beyond a date).
    //
    // The peek for state filtering populates `listing.state`
    // (MemoryListing extension) so we don't double-peek for the
    // penalty multiplier below.
    //
    // Injection-surface widening note (AGENTIC_CLI.md §1.1.5):
    // pre-S6 the state filter `['active']` excluded quarantined
    // bodies from this slot entirely. Post-S6 they reach the slot
    // (with penalty) — the only remaining gate against
    // `trust: untrusted` bodies in retrieve_context is the missing
    // trust filter acknowledged in MEMORY.md §14.3. S6 doesn't
    // violate the §1.1.5 ledger (the gap is documented), but it
    // widens the set of model-facing bodies. Closing the gap —
    // adding a trust filter to the retrieval memory view — is the
    // §14.3 follow-up; until then, operator quarantine discipline
    // is the line of defense for untrusted+quarantined memories.
    const listings = deps.registry.list({
      deduplicateByName: true,
      states: ['active', 'quarantined'],
      includeExpired: false,
    });
    if (listings.length === 0) return [];

    // id → listing lookup. Used twice: once when emitting the BM25
    // corpus, and again when projecting hits back to candidates.
    // Without it the post-rank projection is O(hits × listings);
    // for a small registry that's nothing, but a Map keeps the
    // shape honest as the corpus grows.
    const listingById = new Map<string, (typeof listings)[number]>();

    // Build the corpus. Per-field weighting via token repetition —
    // the BM25 index doesn't care about fields, only term frequencies.
    // We pre-load bodies in one pass when requested so the BM25
    // index sees a complete corpus (avg-doc-length needs all docs
    // sized before scoring starts).
    const docs: BM25Document[] = listings.map((l) => {
      const id = memoryNodeId(l.scope, l.name);
      listingById.set(id, l);
      const nameTokens = tokenize(l.name);
      const descTokens = tokenize(l.entry.hook);
      const tokens: string[] = [];
      for (let i = 0; i < TITLE_WEIGHT; i++) tokens.push(...nameTokens);
      for (let i = 0; i < DESCRIPTION_WEIGHT; i++) tokens.push(...descTokens);
      if (deps.loadBodies === true) {
        // Use `registry.peek` (not `read`) — BM25 corpus
        // construction reads EVERY listed memory body just to
        // compute term frequencies for ranking. Only the top-K
        // hits actually become candidates, and only the included
        // slot entries ever reach the model. Emitting
        // `memory_events action=read` per indexed memory would
        // flood the audit log with rows for content the model
        // never saw — same policy as compression fallback
        // (§retrieval/compression.ts).
        //
        // Scope-pinned via `{ scope: l.scope }`: the listing
        // already carries the post-dedupe winning scope, and
        // pinning makes the body load symmetric with the
        // compression resolver (compression.ts memoryResolver).
        // Without the pin, peek re-walks precedence and could
        // land on a different scope's body if the registry's
        // disk state changes between corpus build and body load
        // — a race the listing-set is supposed to lock down.
        // `present` means body loaded; `missing` / `malformed` /
        // `unknown` fall through as title+description only (the
        // candidate is still ranked on its name + description
        // signal).
        const file = deps.registry.peek(l.name, { scope: l.scope });
        if (file.kind === 'present') {
          const bodyTokens = tokenize(file.file.body);
          for (let i = 0; i < BODY_WEIGHT; i++) tokens.push(...bodyTokens);
        }
      }
      return { id, tokens };
    });

    const index = createBM25Index(docs);
    const hits = index.topK(query.text, limit);

    // Build candidates with a human-readable `reason` so the trace
    // is operator-readable. Reason fields go through the retrieval
    // trace's scrub layer (paths redacted) before persistence;
    // memory names and scopes are stable identifiers, safe to
    // include.
    //
    // Quarantine penalty applies here: a listing with state ===
    // 'quarantined' (carried forward from the registry's filter
    // peek) gets bootstrapScore * QUARANTINED_PENALTY. The reason
    // string carries the marker so trace consumers see why a
    // candidate ranks where it does. The state field is undefined
    // for the unreachable map-miss path; treat unknown as active
    // (no penalty) — quarantined is the OPT-IN penalty path.
    return hits.map((hit) => {
      const listing = listingById.get(hit.id);
      const scopeLabel = listing?.scope ?? 'memory';
      const nameLabel = listing?.name ?? hit.id;
      const isQuarantined = listing?.state === 'quarantined';
      const bootstrapScore = isQuarantined ? hit.score * QUARANTINED_PENALTY : hit.score;
      const reason = isQuarantined
        ? `BM25 match in ${scopeLabel}/${nameLabel} (quarantined ×${QUARANTINED_PENALTY})`
        : `BM25 match in ${scopeLabel}/${nameLabel}`;
      return {
        nodeId: hit.id,
        view: VIEW,
        bootstrapScore,
        reason,
      };
    });
  },
});
