import type { ProviderContentBlock, ProviderMessage } from '../providers/index.ts';
import type { Message, MessageRole } from '../storage/repos/messages.ts';

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

export const messagesToProviderMessages = (rows: Message[]): ProviderMessage[] => {
  const out: ProviderMessage[] = [];
  for (const row of rows) {
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
  return out;
};
