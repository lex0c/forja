import type { Provider, ProviderContentBlock, ProviderMessage } from '../providers/index.ts';
import type { DB } from '../storage/db.ts';
import {
  type MessageSource,
  appendMessage,
  getMessage,
  listMessageTailBySession,
  retractMessage,
} from '../storage/repos/messages.ts';
import {
  type RelevanceElideResult,
  dedupElideMiddle,
  relevanceElideMiddle,
} from './compaction-relevance.ts';
import {
  type CompactionOptions,
  type CompactionResult,
  alignTailStartToAssistant,
  compactMessages,
  goalText,
} from './compaction.ts';
import {
  ALIGNMENT_FETCH_MARGIN,
  MAX_RESUME_MESSAGES,
  STRANDED_TURN_PLACEHOLDER,
  messagesToProviderMessages,
  repairAlternation,
} from './resume.ts';

// SessionContext — the single in-memory source of truth for a live
// session's conversation (MEMORY: project_message_single_source). It
// owns the `ProviderMessage[]` the model actually sees and the
// `lastMessageId` DB-chain anchor, and is the ONLY place that mutates
// them: every append does array-push + appendMessage(row) + anchor
// update together, so the three can never drift apart the way they did
// when scattered across the loop.
//
// DB-as-append-only-log invariant: every append* writes exactly one
// row; compact() writes NOTHING. The persisted log stays a complete
// superset of the live array — the live array is the compacted working
// set, the log is the full history. Audit/recap/replay read the log;
// only the harness request path and `/compact` read the live array.
//
// Lifetime: a fresh/resumed run builds a context; the REPL holds it
// across turns (compact-once-reuse) instead of re-deriving from the DB
// every turn. A `--resume` in a new process has no live context and
// rebuilds via hydrateFromDb (the log is the recovery source).

// Diagnostic returned by hydrateFromDb so the caller can emit the
// resume_truncated event + storage.resume_truncated failure row exactly
// as the inline resume path did (loop.ts).
export interface HydrateInfo {
  kept: number;
  totalDropped: number;
  droppedBeyondFetch: number;
  droppedByAlignment: number;
  // Full persisted message count for the session (= the SQL COUNT(*),
  // independent of the fetch window). Lets the uncapped "full"/"summary"
  // resume modes decide whether to warn the operator that a very large
  // history was loaded into memory.
  totalCount: number;
}

// Usage/cost columns for an assistant turn. `usageSeen=false` means the
// adapter emitted no usage event — persist NULL (not zero) so analytics
// can tell "no measurement" from "measured zero" (loop.ts rationale).
export interface AssistantUsage {
  usageSeen: boolean;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
}

// Cheap clone for /compact rollback-on-failure and tests. Messages are
// plain JSON (string | ProviderContentBlock[]); structuredClone is fine.
export interface SessionContextSnapshot {
  sessionId: string;
  messages: ProviderMessage[];
  lastMessageId: string;
}

export class SessionContext {
  readonly sessionId: string;
  private readonly db: DB;
  private readonly messages: ProviderMessage[];
  // DB-chain anchor: the parentId for the NEXT append. '' means "no
  // parent yet" (fresh session) → the next append is a root. After
  // hydrate it is the persisted tail's id so the new turn chains onto
  // the restored history.
  private lastMessageId: string;

  private constructor(
    db: DB,
    sessionId: string,
    messages: ProviderMessage[],
    lastMessageId: string,
  ) {
    this.db = db;
    this.sessionId = sessionId;
    this.messages = messages;
    this.lastMessageId = lastMessageId;
  }

  // Fresh session: empty live array, no chain anchor. The first append
  // becomes a root (parentId null).
  static createFresh(db: DB, sessionId: string): SessionContext {
    return new SessionContext(db, sessionId, [], '');
  }

  // Rebuild the live array from the persisted log — the `--resume`
  // (new process), preassigned, and subagent paths. Reuses the exact
  // bounded fetch + repair (messagesToProviderMessages: orphan tool_use
  // answering, user→user gap fill, truncation placeholder) the inline
  // resume path used, so behavior is identical. The anchor is the
  // persisted tail's id (the new turn chains onto it).
  // `opts.uncapped` (the "full"/"summary" resume modes) loads the ENTIRE
  // persisted log instead of the bounded tail — no MAX_RESUME_MESSAGES cap.
  // Default (capped) keeps the historical bounded fetch + window cut.
  static hydrateFromDb(
    db: DB,
    sessionId: string,
    opts?: { uncapped?: boolean },
  ): { ctx: SessionContext; info: HydrateInfo } {
    const uncapped = opts?.uncapped === true;
    const tail = listMessageTailBySession(
      db,
      sessionId,
      uncapped ? -1 : MAX_RESUME_MESSAGES + ALIGNMENT_FETCH_MARGIN,
    );
    const restored = messagesToProviderMessages(tail.messages, { uncapped });
    const lastFetched = tail.messages[tail.messages.length - 1];
    const anchor = lastFetched !== undefined ? lastFetched.id : '';
    // Copy the repaired array — it must be the mutable instance the
    // context owns (compact() rewrites it in place).
    const ctx = new SessionContext(db, sessionId, restored.messages.slice(), anchor);
    const droppedBeyondFetch = tail.totalCount - tail.messages.length;
    return {
      ctx,
      info: {
        kept: restored.messages.length,
        totalDropped: droppedBeyondFetch + restored.droppedFromHead,
        droppedBeyondFetch,
        droppedByAlignment: restored.droppedFromHead,
        totalCount: tail.totalCount,
      },
    };
  }

  // parentId for the next append: the anchor, or null when there is no
  // parent yet. appendMessage validates a non-null parent belongs to
  // this session.
  private nextParentId(): string | null {
    return this.lastMessageId !== '' ? this.lastMessageId : null;
  }

  // `source` (migration 075) distinguishes operator input from a
  // harness-injected turn (a bg_done wake notification → 'system'); it
  // only affects the persisted row's audit/resume rendering, not the
  // in-memory message the provider sees. Defaults to 'operator'.
  appendUser(
    content: string,
    promptHash: string | null,
    source: MessageSource = 'operator',
  ): string {
    const msg = appendMessage(this.db, {
      sessionId: this.sessionId,
      role: 'user',
      content,
      parentId: this.nextParentId(),
      promptHash,
      source,
    });
    this.lastMessageId = msg.id;
    this.messages.push({ role: 'user', content });
    return msg.id;
  }

  // Persist ALWAYS (the provider call billed input tokens even for an
  // empty turn), but mirror into the live array ONLY when there is
  // content — an empty assistant message on the wire is rejected/taken
  // literally by some providers.
  appendAssistant(
    content: ProviderContentBlock[],
    usage: AssistantUsage,
    promptHash: string | null,
    // Resolved provider reasoning-effort for the request that produced this
    // turn (migration 074) — the per-call dimension for regression
    // attribution. Null when no effort was resolved.
    effort: string | null = null,
    // The model that billed this turn (migration 077) — the per-request provider
    // id (e.g. 'ollama/glm-5.2'). A `/model` switch changes it per turn, so it is
    // passed per call, not stored on the context. Null when no provider resolved.
    model: string | null = null,
  ): string {
    const hasContent = content.length > 0;
    const msg = appendMessage(this.db, {
      sessionId: this.sessionId,
      role: 'assistant',
      parentId: this.nextParentId(),
      content: hasContent ? content : '',
      tokensIn: usage.usageSeen ? usage.tokensIn : null,
      tokensOut: usage.usageSeen ? usage.tokensOut : null,
      cachedTokens: usage.usageSeen ? usage.cacheRead : null,
      cacheCreationTokens: usage.usageSeen ? usage.cacheCreation : null,
      costUsd: usage.usageSeen ? usage.costUsd : null,
      promptHash,
      effort,
      model,
    });
    this.lastMessageId = msg.id;
    if (hasContent) {
      this.messages.push({ role: 'assistant', content });
    }
    return msg.id;
  }

  appendToolResults(content: ProviderContentBlock[], promptHash: string | null): string {
    const msg = appendMessage(this.db, {
      sessionId: this.sessionId,
      role: 'user',
      parentId: this.nextParentId(),
      content,
      promptHash,
    });
    this.lastMessageId = msg.id;
    this.messages.push({ role: 'user', content });
    return msg.id;
  }

  // Un-send the trailing operator turn after a HARD abort that cut the request
  // before any assistant turn settled. Drops it from the LIVE array (the
  // provider won't see it next turn) AND marks the persisted row retracted
  // (migration 079): append-only, so the row stays for the transcript / audit
  // (rendered "cancelled"), but the model-facing rebuild skips it — making the
  // un-send durable across `--resume`.
  //
  // Refuses (returns false) unless the operator's message is genuinely the last
  // thing that happened:
  //   1. the in-memory tail must be a string-content user turn (an assistant
  //      tail, or a tool_result user turn with array content, is never an
  //      operator message, and popping it would corrupt alternation); AND
  //   2. `lastMessageId` must point at THAT same row. `appendAssistant` advances
  //      `lastMessageId` even for an EMPTY turn it does NOT mirror into the array
  //      (see its `hasContent` guard), so a string-user tail alone doesn't prove
  //      nothing settled — if an (empty) assistant turn settled after the
  //      message, it earned a response and is kept. Without this check the
  //      retraction would hit the wrong row (the empty assistant), losing
  //      durability and mislabeling the audit; AND
  //   3. that row must be `source === 'operator'`. A `system`/wake user row
  //      (migration 075 — a bg_done notification) has identical string-user
  //      shape, so this keeps the invariant ("only the operator's submit is
  //      un-sendable") inside the primitive instead of relying solely on the
  //      repl gate to never call this for a wake turn.
  popLastUserMessage(): boolean {
    const tail = this.messages[this.messages.length - 1];
    if (tail === undefined || tail.role !== 'user' || typeof tail.content !== 'string') {
      return false;
    }
    const last = getMessage(this.db, this.lastMessageId);
    if (
      last === null ||
      last.role !== 'user' ||
      typeof last.content !== 'string' ||
      last.source !== 'operator'
    ) {
      return false;
    }
    this.messages.pop();
    retractMessage(this.db, this.lastMessageId);
    return true;
  }

  // Heal the live array before a turn uses it. Two repairs, both in-memory
  // only (not persisted — the DB log re-derives them on resume):
  //   1. Orphaned tool_use / internal user→user — a turn aborted mid-tool
  //      leaves an assistant tool_use with no tool_result. The REUSE path
  //      does NOT round-trip through hydrate's repair, so without this the
  //      next provider request 400s on the unanswered tool_use and wedges
  //      the live session (the bug the old resume-every-turn path masked).
  //      Idempotent on a clean array (no orphan / no gap ⇒ repaired equals
  //      the input). Copied back UNCONDITIONALLY — a partial answer repairs
  //      in place without changing length, so a length guard would skip it.
  //   2. Stranded turn — if the (repaired) tail is a `user` and a new user
  //      prompt follows, insert a synthetic assistant so the wire alternates.
  ensureAlternation(willAppendUser: boolean): void {
    // Copy back UNCONDITIONALLY: repairAlternation can fix the array
    // WITHOUT changing its length. The partial-answer case — an assistant
    // with N tool_use blocks where the next user answers only some —
    // rewrites that user message in place with the missing synthetic
    // results, same length. A length-only guard would skip exactly that
    // repair and leave an unanswered tool_use for the next reused turn →
    // provider 400 (the very wedge this is meant to prevent).
    const repaired = repairAlternation(this.messages);
    this.messages.length = 0;
    this.messages.push(...repaired);
    const tail = this.messages[this.messages.length - 1];
    if (willAppendUser && tail !== undefined && tail.role === 'user') {
      this.messages.push({ role: 'assistant', content: STRANDED_TURN_PLACEHOLDER });
    }
  }

  // Compact the live array in place. Does NOT persist (DB stays the
  // full log). Returns the CompactionResult so the caller folds the
  // summary call's usage/cost and emits compaction_finished. The
  // identity guard skips the rewrite on the 'skipped' strategy (which
  // returns the SAME array — clearing it first would empty the result).
  async compact(provider: Provider, options: CompactionOptions): Promise<CompactionResult> {
    const result = await compactMessages(provider, this.messages, options);
    if (result.messages !== this.messages) {
      this.messages.length = 0;
      this.messages.push(...result.messages);
    }
    return result;
  }

  // Cheap relevance pre-pass — NO provider call. Pointer-elide
  // low-goal-relevance tool_result bodies in the middle span (between
  // the goal and the last `preserveTail` messages), keeping goal + tail
  // verbatim. Rewrites the live array in place when anything was elided.
  // The loop runs this BEFORE the billed LLM compaction and re-checks
  // tokens (loop.ts maybeCompact); /compact runs it the same way. The
  // decision is clock-free (recency by position), so replay reproduces
  // the same partition. Returns null when there's nothing to elide
  // (history too short, or no middle after the tail).
  relevanceElide(opts: {
    verbatimBudgetBytes: number;
    preserveTail: number;
    // Extra text blended into the BM25 query (the model's CURRENT focus, e.g.
    // the working-state `focus`). The original goal (messages[0]) anchors the
    // overall task, but on a long evolving session the active sub-task drifts
    // from it; scoring against goal ALONE keeps tool_results relevant to the old
    // ask and can elide ones relevant to what the model is doing NOW. Blending
    // the live focus steers relevance toward the current direction. Optional —
    // absent (no working-state focus) degrades to goal-only (prior behavior).
    queryHint?: string;
  }): RelevanceElideResult | null {
    const safeTail = Math.max(0, opts.preserveTail);
    if (this.messages.length < safeTail + 2) return null;
    const goal = this.messages[0];
    if (goal === undefined) return null;
    // Same assistant-aligned tail boundary compactMessages uses, so the
    // preserved tail is identical whether this turn ends up on the
    // relevance path or falls through to the LLM fold.
    const tailStart = alignTailStartToAssistant(this.messages, safeTail);
    if (tailStart === null) return null;
    const middle = this.messages.slice(1, tailStart);
    if (middle.length === 0) return null;
    const query =
      opts.queryHint !== undefined && opts.queryHint.length > 0
        ? `${goalText(goal)}\n${opts.queryHint}`
        : goalText(goal);
    // Cheap exact-duplicate pre-pass before the relevance fold: outputs that
    // appear verbatim more than once (re-reads, re-run greps/tests) collapse to
    // a back-reference, so the relevance budget isn't spent on redundant copies.
    // Both passes are pure/clock-free, so replay reproduces the same partition.
    const deduped = dedupElideMiddle(middle);
    const relevance = relevanceElideMiddle(deduped.middle, {
      goalText: query,
      verbatimBudgetBytes: opts.verbatimBudgetBytes,
      // Never re-elide what dedup already pointered, so the two passes' id-sets
      // stay disjoint regardless of the dedup pointer's length.
      excludeIds: new Set(deduped.elidedIds),
    });
    // Fold both passes into one `relevance` result — no new strategy / no
    // migration: counts + freed bytes sum, elided ids concatenate. The sets are
    // disjoint BY CONSTRUCTION (relevance was told to exclude the dedup ids).
    const result: RelevanceElideResult = {
      middle: relevance.middle,
      elidedCount: deduped.elidedCount + relevance.elidedCount,
      keptCount: relevance.keptCount,
      freedBytes: deduped.freedBytes + relevance.freedBytes,
      elidedIds: [...deduped.elidedIds, ...relevance.elidedIds],
    };
    if (result.elidedCount > 0) {
      const tail = this.messages.slice(tailStart);
      this.messages.length = 0;
      this.messages.push(goal, ...result.middle, ...tail);
    }
    return result;
  }

  // The live view the provider request reads. Readonly: callers that
  // need a mutable copy (the request snapshot) spread it.
  getMessages(): readonly ProviderMessage[] {
    return this.messages;
  }

  // The DB-chain tail, for HarnessResult.lastMessageId. The compacted
  // head (synthetic [compacted_history]) has no row and is never used
  // as a parentId — this always points at a real persisted row.
  getLastMessageId(): string {
    return this.lastMessageId;
  }

  get length(): number {
    return this.messages.length;
  }

  snapshot(): SessionContextSnapshot {
    return {
      sessionId: this.sessionId,
      messages: structuredClone(this.messages),
      lastMessageId: this.lastMessageId,
    };
  }

  restore(snap: SessionContextSnapshot): void {
    // Guard against restoring a snapshot from a DIFFERENT context: its
    // lastMessageId points at another session's row, so the next append
    // would build a cross-session chain (appendMessage then throws). Today
    // /compact round-trips the same instance; this is cheap defense.
    if (snap.sessionId !== this.sessionId) {
      throw new Error(
        `SessionContext.restore: snapshot is from session ${snap.sessionId}, not ${this.sessionId}`,
      );
    }
    this.messages.length = 0;
    this.messages.push(...snap.messages);
    this.lastMessageId = snap.lastMessageId;
  }
}
