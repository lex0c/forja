// BM25 ranking utility shared across retrieval views
// (RETRIEVAL.md §3.2 + §5.1).
//
// Per spec §0 principle 2 ("lexical/estrutural primeiro, semântico
// opt-in") BM25 is the v1 lexical backbone. We hand-roll it (~40
// lines) rather than pulling a dependency: the corpus is bounded by
// the substrate (dozens of memories, hundreds of session events),
// the per-query cost is O(|tokens_in_query| × |docs|) which is fine
// at this scale, and we avoid adding a transitive dependency surface
// to a project that compiles to a single binary.
//
// Pre-tokenization is the caller's responsibility — that's how views
// encode field weighting (e.g., the memory view repeats title tokens
// 3x so a name hit weighs 3x a body hit). Spec §3 stays agnostic on
// per-field weights; views own that policy.
//
// Constants k1 = 1.5, b = 0.75 are textbook defaults. Tuning is a
// v2/v3 concern once offline eval (§10.3) has signal to point at.

const K1 = 1.5;
const B = 0.75;

// ASCII word tokenizer — lowercase, split on non-alphanumeric.
// Spec §0 principle 2 calls for lexical-first; that means matching
// what an operator would type, not a stemmed/lemmatized form.
// Operators searching for "validateToken" and "validate_token"
// produce different token streams — that's a feature, the surface
// is supposed to be honest about literal matches. v2 can add
// stemming if eval suggests it.
export const tokenize = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export interface BM25Document {
  // Stable identifier the caller will receive back in score lookups.
  id: string;
  // Pre-tokenized terms. Empty docs are allowed (score 0).
  tokens: string[];
}

export interface BM25Index {
  // Score one document against a query string. Caller tokenizes the
  // query the same way `tokenize` does (or supplies pre-tokenized
  // form via `scoreTokens`). Returns 0 when no query token appears
  // in the document.
  score(queryText: string, docId: string): number;
  scoreTokens(queryTokens: readonly string[], docId: string): number;
  // Return the top-K documents by score, descending. Documents
  // with score 0 are filtered out — they have no overlap with the
  // query.
  topK(queryText: string, k: number): BM25Hit[];
}

export interface BM25Hit {
  id: string;
  score: number;
}

// Build the index. O(Σ doc length) prep cost; subsequent score /
// topK queries are O(|query tokens| * (doc count for topK, or 1
// for score)). Suitable for the retrieval pipeline's bounded
// corpora; switch to an inverted-index store if a view's corpus
// crosses ~10k docs (way past v1 expectations).
export const createBM25Index = (docs: readonly BM25Document[]): BM25Index => {
  // term → docCount (df) for IDF.
  const df = new Map<string, number>();
  // term → docId → term frequency in that doc.
  const tf = new Map<string, Map<string, number>>();
  const docLengths = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    docLengths.set(doc.id, doc.tokens.length);
    totalLen += doc.tokens.length;
    const seen = new Set<string>();
    for (const token of doc.tokens) {
      let perTerm = tf.get(token);
      if (perTerm === undefined) {
        perTerm = new Map();
        tf.set(token, perTerm);
      }
      perTerm.set(doc.id, (perTerm.get(doc.id) ?? 0) + 1);
      seen.add(token);
    }
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const N = docs.length;
  // Average doc length. Guard against empty corpus so length-norm
  // doesn't divide by zero (the score loop early-returns on 0
  // anyway, but the guard makes the intent explicit).
  const avgDl = N === 0 ? 0 : totalLen / N;

  const scoreTokens = (queryTokens: readonly string[], docId: string): number => {
    if (N === 0) return 0;
    const dl = docLengths.get(docId);
    if (dl === undefined) return 0;
    const lenNorm = avgDl === 0 ? 0 : dl / avgDl;
    let sum = 0;
    for (const q of queryTokens) {
      const n = df.get(q);
      if (n === undefined || n === 0) continue;
      // BM25 IDF (Lucene formulation — `+1` outside the log keeps
      // IDF non-negative for terms appearing in most docs, which
      // would otherwise produce negative contributions).
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      const termFreq = tf.get(q)?.get(docId) ?? 0;
      if (termFreq === 0) continue;
      const tfNorm = (termFreq * (K1 + 1)) / (termFreq + K1 * (1 - B + B * lenNorm));
      sum += idf * tfNorm;
    }
    return sum;
  };

  const score = (queryText: string, docId: string): number =>
    scoreTokens(tokenize(queryText), docId);

  const topK = (queryText: string, k: number): BM25Hit[] => {
    const qTokens = tokenize(queryText);
    if (qTokens.length === 0 || N === 0) return [];
    const hits: BM25Hit[] = [];
    for (const doc of docs) {
      const s = scoreTokens(qTokens, doc.id);
      if (s > 0) hits.push({ id: doc.id, score: s });
    }
    // Score descending, id ascending as deterministic tiebreaker.
    // Without the tiebreaker, two docs with equal scores would
    // ping-pong order across queries and trace replays would diff.
    hits.sort((a, b) => (b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score));
    return hits.slice(0, k);
  };

  return { score, scoreTokens, topK };
};
