import type {
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolResultBlock,
  ProviderToolUseBlock,
} from '../providers/index.ts';
import type { Message, MessageRole } from '../storage/repos/messages.ts';

// Hard cap on how many persisted messages we reload at resume init.
// Compaction trims the in-memory array during a normal run, but the
// persisted log keeps every appendMessage call — a long uncompacted
// session, or one that crashed mid-compaction, can accumulate
// thousands of rows. Loading them all on resume is the same
// unbounded-buffer trap the playbook §5.3 calls out: GC pressure
// at best, OOM at worst. 500 is generous (compaction targets a
// fraction of that for the active window) and keeps a resumed run
// inside the same memory envelope as a fresh one.
//
// Truncation policy: keep the MOST RECENT 500 messages, drop the
// older tail. Recency matters more than depth for continuity —
// the model's most useful context is what came right before the
// new follow-up.
export const MAX_RESUME_MESSAGES = 500;

// Above this many loaded rows, the uncapped "full"/"summary" resume modes warn
// the operator that a large history was pulled into memory (the capped default
// exists precisely to avoid this). Advisory only — not a hard limit.
export const RESUME_FULL_WARN_THRESHOLD = 2000;

// Extra rows fetched beyond MAX_RESUME_MESSAGES so the alignment
// walk in messagesToProviderMessages has room to skip past
// user_tool_result rows when looking for a safe head. Without the
// margin, a tail composed of [user_tr, user_tr, ..., assistant]
// (where the user_tool_result run exceeds MAX) would leave no
// safe boundary inside the kept window and produce an empty
// restored slice. 100 rows ≈ 50 turns of slack — generous for
// any realistic conversation shape.
export const ALIGNMENT_FETCH_MARGIN = 100;

// Stand-in user prompt prepended when truncation lands on an
// assistant message. Anthropic's API (and others) require the
// first message to be `user`, so a kept slice starting with
// assistant would 400 even though tool_use ↔ tool_result pairs
// are intact behind it. The placeholder satisfies the role-
// alternation rule without introducing fake content the model
// could mistake for a real instruction.
export const TRUNCATION_PLACEHOLDER =
  '[Earlier conversation truncated to fit the resume memory budget. Continuing from this turn.]';

// In-memory-only synthetic assistant turn used when the prior run
// aborted before the model produced its response — persisted log
// ends with a `user` (the root prompt OR a tool_result that the
// crashed run never got back to). Appending the resume's new user
// prompt directly would put two consecutive user messages on the
// wire, which every provider rejects as an alternation violation.
//
// The placeholder is inserted between the persisted tail and the
// new prompt; it is NOT persisted (each resume re-derives it as
// needed). Distinct from TRUNCATION_PLACEHOLDER (which fills the
// HEAD of the slice when the cap drops the original root) — both
// solve alternation problems but at opposite ends of the message
// list.
export const STRANDED_TURN_PLACEHOLDER =
  '[The previous turn was interrupted before a response was produced. Continuing from this point.]';

// Synthetic tool_result content for a tool_use that an aborted run
// never answered. Inserted by repairOrphanedToolUses so the replayed
// history satisfies the provider's "every tool_use needs a
// tool_result" rule. is_error so the model treats it as a non-result.
export const ORPHAN_TOOL_RESULT_PLACEHOLDER =
  '[Tool call interrupted — the run ended before this tool produced a result.]';

// Reconstruct the in-memory ProviderMessage[] from persisted rows.
// Today the harness only persists role='user' and role='assistant'
// — tool results are wrapped in user-role messages whose content is
// a ProviderContentBlock[] array of tool_result blocks (see loop.ts
// around the appendMessage calls). The 'tool' role exists in the DB
// schema for forward compatibility but isn't emitted; if it ever
// shows up here, we skip it (it has no canonical mapping in the
// current ProviderMessage shape).
//
// `content` came back through parseJsonSafe from the DB, so it's
// already the structural value the provider expects — either a
// plain string (the first userPrompt) or a ProviderContentBlock[]
// array. We trust the round-trip: the harness wrote what it pushed
// to `messages` verbatim, so reading it back yields the same shape.
const isAssistantOrUser = (role: MessageRole): role is 'user' | 'assistant' =>
  role === 'user' || role === 'assistant';

export interface ReconstitutedMessages {
  messages: ProviderMessage[];
  // Diagnostic: how many rows were truncated from the head of the
  // persisted log to fit MAX_RESUME_MESSAGES. The harness exposes
  // this through events so a renderer can show "resumed with N of
  // M messages, M-N older messages dropped".
  droppedFromHead: number;
}

// Boundary safety: the kept slice MUST start at a position where
// the provider can replay it without orphaning any reference. The
// harness loop produces alternation
//   [user_root, assistant, user_tool_result, assistant, user_tool_result, ...]
// and tool_result blocks reference tool_use blocks emitted by the
// IMMEDIATELY preceding assistant. So contiguous suffixes preserve
// tool-pair integrity already — the only failure mode is a kept
// slice whose head is a `user` carrying tool_result blocks: that
// row's tool_use was in the dropped assistant, leaving an orphan.
//
// Two safe head-of-slice shapes:
//   - assistant (its tool_use blocks are intact in this row; the
//     following user_tool_result references THIS assistant)
//   - user with string content (a fresh prompt — root or post-
//     resume continuation; carries no tool_result references)
//
// When the cut lands on a user-tool_result, walk forward to the
// next safe row. If the resulting head is `assistant`, prepend a
// synthetic user message so provider role-alternation rules
// (Anthropic requires first message = user) still hold. The
// placeholder is small and stable; it doesn't pretend to summarize
// the dropped history (that's compaction's job, which costs an
// LLM call we can't afford at resume init).
const isSafeHead = (row: Message): boolean => {
  if (row.role === 'assistant') return true;
  if (row.role === 'user' && typeof row.content === 'string') return true;
  return false;
};

// Compute how many rows to drop from the head of a persisted tail
// so the kept slice (a) fits MAX_RESUME_MESSAGES and (b) starts at
// a provider-safe boundary (assistant, or user-with-string — never
// an orphan user_tool_result). Pure index math, no allocation.
//
// Exported so the resume scrollback replay (src/cli/resume-replay.ts)
// can drive its visual window from the EXACT same cut the model's
// context uses. If the two diverge, the operator sees turns in
// scrollback that the model can't actually reference — a silent
// mislead. Sharing this function keeps them in lockstep.
// `cap` is the max number of recent rows to keep. Default = MAX_RESUME_MESSAGES
// (the capped resume window). Pass `Number.POSITIVE_INFINITY` for the
// uncapped "full"/"summary" resume modes: the head-of-window drop is then 0
// (keep everything), but the safe-head walk STILL runs — uncapped must not
// orphan a leading user_tool_result any more than capped does.
export const resumeWindowCut = (rows: Message[], cap: number = MAX_RESUME_MESSAGES): number => {
  // Initial cut so the kept slice holds at most `cap` NON-RETRACTED rows.
  // Retracted (un-sent) rows are dropped from the model context anyway
  // (messagesToProviderMessages) and rendered "(unsent)" in the visual, so they
  // must not consume the resume budget — otherwise a burst of hard-aborted
  // prompts near the tail would evict live conversation from the window. With no
  // retracted rows this reduces to the old `rows.length - cap`.
  let cut = 0;
  if (Number.isFinite(cap)) {
    let live = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i]?.retractedAt === null) {
        live += 1;
        if (live > cap) {
          cut = i + 1; // drop rows[0..i]; keep the last `cap` live + interspersed retracted
          break;
        }
      }
    }
  }
  // Walk forward past unsafe heads (user_tool_result without its
  // matching assistant). If no safe boundary exists in the kept
  // window, cut walks to rows.length and the kept slice is empty —
  // degraded UX (resume effectively starts fresh) but a valid one.
  while (cut < rows.length) {
    const candidate = rows[cut];
    if (candidate === undefined) break;
    if (isSafeHead(candidate)) break;
    cut += 1;
  }
  return cut;
};

// Every assistant `tool_use` block must be answered by a `tool_result`
// in the very next message (the provider contract). A run aborted
// mid-tool-round can persist a history where some tool_use blocks were
// never answered — the provider then 400s on every subsequent request
// and the session is unrecoverable. `resumeWindowCut` only guards the
// HEAD of the slice; this catches orphans anywhere in it. Each orphan
// gets a synthetic error tool_result so the replayed history is valid.
const repairOrphanedToolUses = (msgs: ProviderMessage[]): ProviderMessage[] => {
  const out: ProviderMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const curr = msgs[i];
    if (curr === undefined) continue;
    out.push(curr);
    const toolUses =
      curr.role === 'assistant' && Array.isArray(curr.content)
        ? curr.content.filter((b): b is ProviderToolUseBlock => b.type === 'tool_use')
        : [];
    if (toolUses.length === 0) continue;
    const next = msgs[i + 1];
    const nextResults =
      next !== undefined && next.role === 'user' && Array.isArray(next.content)
        ? next.content
        : null;
    const answered = new Set(
      (nextResults ?? [])
        .filter((b): b is ProviderToolResultBlock => b.type === 'tool_result')
        .map((b) => b.tool_use_id),
    );
    const orphans = toolUses.filter((tu) => !answered.has(tu.id));
    if (orphans.length === 0) continue;
    // `name` is required: the Google adapter correlates tool_result to
    // tool_use by function name (not id) and throws without it.
    const synthetic: ProviderToolResultBlock[] = orphans.map((tu) => ({
      type: 'tool_result',
      tool_use_id: tu.id,
      name: tu.name,
      content: ORPHAN_TOOL_RESULT_PLACEHOLDER,
      is_error: true,
    }));
    if (nextResults !== null) {
      // The next message answers some tool_uses — splice the synthetic
      // results in front of it and consume it.
      out.push({ role: 'user', content: [...synthetic, ...nextResults] });
      i++;
    } else {
      // Nothing answers this turn — insert a fresh result message.
      out.push({ role: 'user', content: synthetic });
    }
  }
  return out;
};

// `opts.uncapped` selects the full-resume path: no MAX_RESUME_MESSAGES cap, so
// the kept slice is the entire log (still safe-head-aligned + orphan-repaired).
export const messagesToProviderMessages = (
  rows: Message[],
  opts?: { uncapped?: boolean },
): ReconstitutedMessages => {
  const droppedFromHead = resumeWindowCut(
    rows,
    opts?.uncapped === true ? Number.POSITIVE_INFINITY : MAX_RESUME_MESSAGES,
  );

  const sliced = droppedFromHead > 0 ? rows.slice(droppedFromHead) : rows;
  const out: ProviderMessage[] = [];
  for (const row of sliced) {
    if (!isAssistantOrUser(row.role)) continue;
    // Operator un-sent this turn (migration 079): keep it out of the
    // model-facing context so the un-send is durable across resume. The
    // transcript / recap still render it ("cancelled") from the raw row — only
    // the reconstituted provider messages drop it. `resumeWindowCut` above budgets
    // the window in NON-retracted rows (and the bounded fetch likewise), so a
    // burst of un-sends near the tail can't evict live conversation; the visual
    // replay shares that same cut, so the windows stay aligned.
    if (row.retractedAt !== null) continue;
    // The cast is unverified: the persistence layer stored arbitrary
    // JSON content (parseJsonSafe → unknown), and we trust that the
    // loop wrote shapes the provider can later consume. There is no
    // schema versioning on `messages.content` today; if a future
    // change to how the loop encodes content lands without a
    // migration, an old DB resumed against new code would surface
    // the mismatch downstream as a provider error, not here. Worth
    // tracking when the audit/forensics work introduces real schema
    // versioning (AGENTIC_CLI §13).
    out.push({
      role: row.role,
      content: row.content as string | ProviderContentBlock[],
    });
  }
  // If we cut at an assistant message, prepend the synthetic user
  // placeholder so the provider sees the required user-first
  // alternation. Skipped when the head is already user (either
  // user_root preserved, or out is empty).
  if (out[0]?.role === 'assistant') {
    out.unshift({ role: 'user', content: TRUNCATION_PLACEHOLDER });
  }
  return { messages: repairAlternation(out), droppedFromHead };
};

// Repair a ProviderMessage[] so a provider accepts it: (1) answer orphaned
// tool_use blocks — a mid-tool abort persists a tool_use with no
// tool_result, and one unanswered tool_use 400s the whole request; (2)
// close internal user→user gaps — repeated aborted resumes accumulate them
// — with a synthetic assistant (STRANDED_TURN_PLACEHOLDER, "the model never
// got to reply"). Idempotent on a clean array (no orphan / no gap ⇒ same
// length). Used by the hydrate path above AND, critically, by
// SessionContext.ensureAlternation on the REPL reuse path: reuse does NOT
// round-trip through hydrate, so without running this an abort-induced
// orphan tool_use would wedge every subsequent live turn with a 400.
export const repairAlternation = (msgs: ProviderMessage[]): ProviderMessage[] => {
  const deOrphaned = repairOrphanedToolUses(msgs);
  const repaired: ProviderMessage[] = [];
  for (let i = 0; i < deOrphaned.length; i++) {
    const curr = deOrphaned[i];
    if (curr === undefined) continue;
    repaired.push(curr);
    const next = deOrphaned[i + 1];
    if (curr.role === 'user' && next !== undefined && next.role === 'user') {
      repaired.push({ role: 'assistant', content: STRANDED_TURN_PLACEHOLDER });
    }
  }
  return repaired;
};
