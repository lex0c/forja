import type { ProviderContentBlock, ProviderMessage } from '../providers/index.ts';
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

export const messagesToProviderMessages = (rows: Message[]): ReconstitutedMessages => {
  let cut = rows.length > MAX_RESUME_MESSAGES ? rows.length - MAX_RESUME_MESSAGES : 0;
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
  const droppedFromHead = cut;

  const sliced = droppedFromHead > 0 ? rows.slice(droppedFromHead) : rows;
  const out: ProviderMessage[] = [];
  for (const row of sliced) {
    if (!isAssistantOrUser(row.role)) continue;
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
  return { messages: out, droppedFromHead };
};
