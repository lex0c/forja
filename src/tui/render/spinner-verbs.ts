// Spinner verb pools for the cognitive (thinking), output
// (generating) and tool-orchestration chips. Replaces the flat
// "Thinking…" / "Generating…" labels with rotating, on-brand
// verbs that match Forja's industrial / operational framing — the
// agent reads as "system executing a cognitive pipeline" rather
// than "chatbot doing stand-up".
//
// Selection is DETERMINISTIC, not random: each verb is chosen by
// hashing a stable per-turn seed (the assistant message id) into
// a pool index. Two consequences:
//
//   1. The verb stays stable WITHIN a turn — consecutive frames
//      don't flicker between "Reasoning" and "Analyzing" while
//      the same thinking pass runs. Operator perceives the chip
//      as one stable label, not a strobe.
//   2. The verb varies ACROSS turns — different turns hash to
//      different pool indices, giving the variety the brand
//      asks for without sacrificing per-turn coherence.
//
// Why separate pools instead of one merged list:
//
//   - Thinking, generating and tool execution are semantically
//     distinct phases. Mixing pools would let a turn surface
//     "Forging…" during the thinking pass (no output yet),
//     "Reasoning…" during text streaming (no inference happening)
//     or either of those while a tool runs (the model is idle,
//     the harness is executing) — verbs become decorative, no
//     longer informative.
//
//   - Cognitive verbs (Reasoning, Analyzing, …) describe what
//     the model is actually doing during extended thinking:
//     decomposing the prompt, weighing options, deriving
//     conclusions. Output verbs (Forging, Refining, …) describe
//     active production of structured artifacts — closer to what
//     happens once text starts streaming.
//
// Pool size is intentionally small (5 each). Larger pools dilute
// the meaning of any single verb and the operator's eye starts
// treating them as noise. Five gives variety across a session
// without crossing into "every turn is a different word".
//
// Pool composition follows two themed clusters from the brand
// vocabulary, each picked because the cluster as a whole reads
// COHERENT (verbs feel like they came from the same dictionary):
//
//   - COGNITIVE_VERBS — "research lab" cluster. The thinking
//     pass is internal cognition: decomposing, weighing,
//     deriving. Lab verbs (Modeling, Synthesizing, …) match
//     that activity precisely. Verbs from the "minimalist
//     technical" cluster (Analyzing, Indexing) sit closer to
//     tool actions than to model reasoning, so they're
//     reserved for tool active verbs in a future slice.
//
//   - OUTPUT_VERBS — "Forge OS" cluster. The generating phase
//     is artifact production. Metallurgical verbs (Forging,
//     Tempering, …) carry the right active connotation and
//     align with Forja's brand. The cluster name is literal:
//     Forging is the namesake verb; the rest extend the
//     metaphor coherently.
//
//   - TOOL_VERBS — "agent infrastructure" cluster. The tool
//     phase is the harness executing tool calls the model
//     emitted: the activity IS coordination (running, dispatching,
//     sequencing the calls), not cognition or text production.
//     Orchestration verbs (Orchestrating, Dispatching, …) name
//     that precisely. Surfaced by the tool-phase chip
//     (`render/tool-phase-chip.ts`), pinned at the bottom of the
//     live region while the tool cards stack above it — so the
//     indicator never goes blank mid-turn.
//
// Other clusters in the brand vocabulary are NOT used here:
//
//   - "Minimalist technical" (Analyzing, Indexing, Verifying,
//     Refining, Executing) — better fit for PER-TOOL active
//     verbs (read_file → Indexing, run_tests → Verifying); the
//     tool-phase chip above is a single turn-level indicator, not
//     a per-card one, so it draws from the orchestration cluster
//     instead.

const COGNITIVE_VERBS = [
  'Modeling',
  'Synthesizing',
  'Deriving',
  'Correlating',
  'Evaluating',
] as const;

const OUTPUT_VERBS = ['Forging', 'Tempering', 'Hardening', 'Smelting', 'Shaping'] as const;

const TOOL_VERBS = [
  'Orchestrating',
  'Dispatching',
  'Sequencing',
  'Coordinating',
  'Consolidating',
] as const;

// Simple deterministic string hash → non-negative integer. Not
// cryptographic — we only need stable distribution across the
// small pool sizes. The 31-multiplier (Java's `String.hashCode`
// constant) gives good spread across short ids (Anthropic's
// `msg_01ABC…` shape) and across the synthetic `unknown-<ts>`
// fallbacks the adapter emits when an event lacks a real id.
//
// `| 0` after each step coerces to a 32-bit signed integer (JS
// bitwise ops do this anyway), bounding the running hash so it
// can't overflow into BigInt territory and keeping the modulo
// math fast. The bitwise final step `(h ^ (h >>> 31)) >>> 0`
// produces a non-negative uint32 in one operation — cleaner than
// `Math.abs(h) % mod`, which has a corner case at INT_MIN where
// JS returns `2147483648` (one above INT32_MAX). Doesn't affect
// `% mod` correctness but the bit-twiddle expresses the intent
// directly: "fold the sign bit, then take the modulo".
const hashIndex = (seed: string, mod: number): number => {
  if (mod <= 0) return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return ((h ^ (h >>> 31)) >>> 0) % mod;
};

// Pool-specific salt prefixes. The two pools share the same hash
// function and (today) the same size (5 each), so `hashIndex(seed, 5)`
// would return the SAME index for both pools given the same seed.
// In practice that means the cognitive verb at index N predicts
// the output verb at index N within a single turn — operators
// attentive to the chip would learn the pairing (Modeling →
// Forging, Synthesizing → Tempering, etc.). Salting the seed per
// pool decouples the two indices: same seed hashes differently
// once mixed with the pool's identity, so the cognitive verb
// gives no information about the output verb. Variety per turn
// stays the same; the patterned coupling goes away.
//
// Salts are short opaque strings (NOT semantic). Their only role
// is to perturb the hash; changing them rotates the historical
// turn-id → verb mapping but doesn't alter the contract (verb
// stable per id, drawn from the pool). Pin via test rather than
// in operator-visible config.
const COGNITIVE_SALT = 'cog';
const OUTPUT_SALT = 'out';

const TOOL_SALT = 'tool';

// Pick a cognitive verb for the thinking chip. Stable for the
// same `seed`, varies across different seeds, INDEPENDENT of the
// output pool's choice for the same seed (per-pool salt). Falls
// back to the first verb when the pool is somehow empty
// (defensive — the pool is hard-coded above, so this branch is
// unreachable in production but the explicit fallback keeps the
// function total for future refactors that might inject the pool
// from config).
export const pickCognitiveVerb = (seed: string): string => {
  const i = hashIndex(COGNITIVE_SALT + seed, COGNITIVE_VERBS.length);
  return COGNITIVE_VERBS[i] ?? COGNITIVE_VERBS[0];
};

export const pickOutputVerb = (seed: string): string => {
  const i = hashIndex(OUTPUT_SALT + seed, OUTPUT_VERBS.length);
  return OUTPUT_VERBS[i] ?? OUTPUT_VERBS[0];
};

// Pick a tool-orchestration verb for the tool-phase chip. Same
// contract as the other pickers: stable for the same `seed`,
// varies across seeds, independent of the cognitive/output pools
// (per-pool salt) so a turn that thinks, generates AND runs tools
// shows three uncoupled verbs rather than a learnable triple.
export const pickToolVerb = (seed: string): string => {
  const i = hashIndex(TOOL_SALT + seed, TOOL_VERBS.length);
  return TOOL_VERBS[i] ?? TOOL_VERBS[0];
};

// Test seams. Exported so the test suite can pin the active
// pools without brittleness — a contract change (new verb,
// removed verb, reordered pool) lands with assertion changes
// visible in one place. Production code should NOT iterate
// these; use the picker functions above.
export const COGNITIVE_VERB_POOL: ReadonlyArray<string> = COGNITIVE_VERBS;
export const OUTPUT_VERB_POOL: ReadonlyArray<string> = OUTPUT_VERBS;
export const TOOL_VERB_POOL: ReadonlyArray<string> = TOOL_VERBS;
