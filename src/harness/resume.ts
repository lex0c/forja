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

export const messagesToProviderMessages = (rows: Message[]): ReconstitutedMessages => {
  const droppedFromHead = rows.length > MAX_RESUME_MESSAGES ? rows.length - MAX_RESUME_MESSAGES : 0;
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
  return { messages: out, droppedFromHead };
};
