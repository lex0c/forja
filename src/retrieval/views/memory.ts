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
  async search(query: RetrievalQuery): Promise<Candidate[]> {
    const queryTokens = tokenize(query.text);
    if (queryTokens.length === 0) return [];

    const limit = deps.limit ?? DEFAULT_LIMIT;
    // Use post-dedup listings so a `local` override of a `shared`
    // name doesn't double-count tokens for what is one effective
    // memory at decision time. Spec §2.4 says local > shared > user
    // for resolution; the retrieval surface should reflect what the
    // model would actually see.
    const listings = deps.registry.list({ deduplicateByName: true });
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
        // (§retrieval/compression.ts). `peek` mirrors `read`'s
        // scope precedence (local > shared > user) but skips
        // `auditRead`. `present` means body loaded; `missing` /
        // `malformed` / `unknown` fall through as
        // title+description only (the candidate is still ranked
        // on its name + description signal).
        const file = deps.registry.peek(l.name);
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
    return hits.map((hit) => {
      const listing = listingById.get(hit.id);
      // Map miss here would be a bug (we just populated it from
      // these listings) — fall through to a safe shape rather than
      // crash a downstream consumer.
      const scopeLabel = listing?.scope ?? 'memory';
      const nameLabel = listing?.name ?? hit.id;
      return {
        nodeId: hit.id,
        view: VIEW,
        bootstrapScore: hit.score,
        reason: `BM25 match in ${scopeLabel}/${nameLabel}`,
      };
    });
  },
});
