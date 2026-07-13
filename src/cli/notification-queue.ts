// Semi-push notification queue extracted from repl.ts's runRepl (R2 — reduce the
// god-function). The producer payload types, the two pure formatters (operator
// headline + model wake-turn input), and the pending-queue state (items + id
// seq) move here. The wake-when-idle trigger and the §3B.4 idle/budget drain gate
// stay in runRepl — they read the loop's turn/idle/cost state — and call this
// queue's size / peerMessageCount / drainAll. Behavior is preserved verbatim; the
// repl suite drives the wake path end to end, plus this module's own formatter/
// queue unit tests.
import { framePeerMessage } from '../mesh/envelope.ts';
import { flattenControlToLine } from '../sanitize/ansi.ts';

export type BgDoneNotification = {
  kind: 'bg_done';
  command: string;
  status: 'exited' | 'killed' | 'failed';
  exitCode: number | null;
  processId: string;
  // Head-tail of the process output (OUTPUT_POLICY), read observationally at
  // completion so the model sees the result in the wake-turn without a
  // bash_output round-trip. Undefined when the process was silent or the read
  // failed; the full output is always recoverable via bash_output(processId).
  summary?: string;
};
export type ReminderNotification = {
  kind: 'reminder';
  // The model-authored context that becomes the wake-turn input — the reminder's
  // headline IS the note (no separate body/summary).
  note: string;
  scheduledAt: number;
};
export type PeerMessageNotification = {
  kind: 'peer_message';
  // Peer alias (scrollback origin header + the reply handle in the untrusted
  // preamble). `text` is the raw peer message — a request, a reply, or a
  // follow-up (the wire doesn't distinguish, §4) — enveloped as untrusted DATA
  // before it reaches the model.
  peerAlias: string;
  text: string;
};
// Reply safety net (MESH.md §6.4): a peer-driven turn ended with no mesh_send
// back to a peer we owe. Enqueued at session_finished; drives ONE wake-turn whose
// input tells the model to answer via mesh_send. Harness-authored (the aliases
// are grammar-validated), NOT untrusted peer text — so it is not enveloped.
export type PeerReplyNudgeNotification = {
  kind: 'peer_reply_nudge';
  aliases: string[];
};
// Producer payload (no id yet); the queue stamps the id on push.
export type NotificationPayload =
  | BgDoneNotification
  | ReminderNotification
  | PeerMessageNotification
  | PeerReplyNudgeNotification;
export type Notification =
  | (BgDoneNotification & { id: string })
  | (ReminderNotification & { id: string })
  | (PeerMessageNotification & { id: string })
  | (PeerReplyNudgeNotification & { id: string });

// The headline line — the `● `-able status sentence, no body. One `case` per
// producer `kind`.
export const formatNotificationHeadline = (n: Notification): string => {
  switch (n.kind) {
    case 'bg_done': {
      const code = n.exitCode === null ? '' : ` (exit ${n.exitCode})`;
      return (
        `[background] \`${flattenControlToLine(n.command)}\` ${n.status}${code}. ` +
        `process_id=${n.processId} — read complete output with bash_output.`
      );
    }
    case 'reminder':
      return `[reminder] ${flattenControlToLine(n.note)}`;
    case 'peer_message':
      // Peer alias is attacker-controlled — flatten control/ANSI (like
      // bg_done/reminder) so it can't spoof the operator's scrollback. Name the
      // channel ("peer") — unlike [background]/[reminder] the bare alias gives no
      // cue this came in over the mesh from ANOTHER repo.
      return `▸ peer '${flattenControlToLine(n.peerAlias)}'`;
    case 'peer_reply_nudge': {
      // Dual audience: the operator sees this in scrollback (● [reply pending] …)
      // and the model receives it as the wake-turn input (formatNotification
      // returns the headline verbatim — harness-authored, not enveloped). Names
      // what a prose answer does NOT do (the observed miss) and points at
      // mesh_send — but ALSO that a concluded exchange needs NO reply. Without
      // that, two polite instances ping-pong farewells (each closing message
      // becomes the other's inbound → its own nudge → another closing message)
      // until the wake cap pauses it.
      const who = n.aliases.map((a) => `'${flattenControlToLine(a)}'`).join(', ');
      const one = n.aliases.length === 1;
      const noun = one ? 'peer' : 'peers';
      const verb = one ? 'is' : 'are';
      const them = one ? 'it' : 'them';
      return `[reply pending] ${noun} ${who} ${verb} unanswered over the mesh — your plain text reply, if any, did NOT reach ${them}. If you owe a real answer or a decision, call mesh_send now. If the exchange has simply run its course (a thanks or a goodbye needs no reply), just end the turn — do NOT send another closing message back. Either way you will not be reminded again.`;
    }
  }
};

// Full text fed to the model as the wake-turn input: headline + any attached
// body. Only bg_done carries a body (the output head-tail); reminder's headline
// is complete on its own.
export const formatNotification = (n: Notification): string => {
  // A peer message is fed to the model enveloped as untrusted DATA (§5.2) — NOT
  // the operator-facing origin headline. To respond, the model calls mesh_send
  // back to the alias (this turn or a later one — §6.4).
  if (n.kind === 'peer_message') return framePeerMessage(n.peerAlias, n.text);
  return n.kind === 'bg_done' && n.summary !== undefined
    ? `${formatNotificationHeadline(n)}\n${n.summary}`
    : formatNotificationHeadline(n);
};

// The pending semi-push queue: producers push payloads (the queue stamps a
// monotonic id), the idle-drain gate reads size / peerMessageCount and drains the
// whole batch into one wake-turn.
export class NotificationQueue {
  #items: Notification[] = [];
  #seq = 0;

  push(payload: NotificationPayload): void {
    // Spreading a discriminated union widens `kind` (a known TS quirk), so cast
    // back to the union after stamping the id — the spread only adds `id`, the
    // variant fields are untouched.
    this.#items.push({ ...payload, id: String(this.#seq++) } as Notification);
  }

  size(): number {
    return this.#items.length;
  }

  peerMessageCount(): number {
    return this.#items.reduce((acc, n) => acc + (n.kind === 'peer_message' ? 1 : 0), 0);
  }

  // Remove and return the whole pending batch (§6.2 coalesce-into-one-wake).
  drainAll(): Notification[] {
    return this.#items.splice(0);
  }
}
