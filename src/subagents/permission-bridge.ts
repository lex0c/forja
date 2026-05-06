// Child-side permission proxy bridge. Translates the engine's
// `confirm` verdict (which `invoke-tool.ts` surfaces as a call to
// `confirmPermission`) into a `permission:ask` IPC message and
// blocks until the matching `permission:answer` returns. Spec:
// docs/spec/IPC.md §3, §7.
//
// Until this module landed, a child subagent that hit a `confirm`
// verdict had `confirmPermission === undefined` in its harness
// config, which `invoke-tool.ts:341` falls back to denial for.
// Behavior was safe (no auto-allow) but operator-invisible: the
// human never saw that the child wanted to do something the
// policy gated.
//
// Design constraints from spec §7: "filho NUNCA recebe
// auto-approve via IPC; o canal só transporta a decisão do
// humano." This bridge MUST NOT short-circuit with an allow
// verdict for any reason — every positive answer originates from
// an operator at the parent's modal.

import { type IpcChannel, makePermissionAsk } from './ipc.ts';

// Mirrors `HarnessConfig.confirmPermission`'s request shape so the
// bridge can be wired in directly without an adapter. The wire
// re-types `args` to `unknown` (the parser is opaque) but the
// bridge's input contract stays aligned with the rest of the
// harness — any drift here would force callers into a wrapper.
export interface PermissionBridgeRequest {
  // Tool that triggered the engine's confirm verdict. The parent's
  // modal renders this verbatim — sanitization is the parent's
  // responsibility (anti-spoof: a malicious child can't be
  // trusted to display a clean name to the operator).
  toolName: string;
  // Raw tool args, as the model emitted them. Opaque on the wire;
  // the parent's modal renderer narrows by tool name.
  args: Record<string, unknown>;
  // Child's effective cwd at the time of the ask. Surfaced in the
  // modal so the operator can distinguish a child editing the
  // worktree vs the parent's cwd.
  cwd: string;
  // The engine's prompt — the human-readable "why did the policy
  // ask?" string. Built by the engine from the matching rule.
  prompt: string;
}

export interface ChildPermissionBridge {
  // Drop-in for `HarnessConfig.confirmPermission`. Returns true on
  // operator allow, false on operator deny / cancel / channel
  // failure / abort. Never throws.
  confirmPermission: (req: PermissionBridgeRequest) => Promise<boolean>;
  // Number of asks awaiting an answer. Tests inspect; production
  // code does not branch on it.
  pendingCount: () => number;
  // Tear down the bridge: rejects every pending ask, drops the
  // channel/abort subscriptions, and short-circuits future
  // confirmPermission calls to a denial. Idempotent.
  dispose: () => void;
}

export interface CreateChildPermissionBridgeOptions {
  channel: IpcChannel;
  // Hard abort signal. When fired, every pending ask resolves to
  // a denial — the operator's chance to answer is gone. Mirrors
  // invoke-tool's existing raceAgainstAbort behavior so the
  // bridge layer doesn't introduce a new abort idiom.
  signal: AbortSignal;
  // Test seam for promptId generation. Production callers omit;
  // crypto.randomUUID is used.
  newPromptId?: () => string;
  // Optional diagnostic sink for protocol-violation conditions
  // the bridge layer can observe — currently only "parent answered
  // with an unknown promptId" (we already drained the pending
  // entry via close/dispose/abort, then a stale answer arrived).
  // Malformed-line errors land on `channel.onError` and are
  // surfaced by the runtime's IPC observer at the parent side,
  // not here. Defaults to process.stderr — same convention as
  // the rest of the IPC layer.
  errSink?: (line: string) => void;
}

interface PendingEntry {
  resolve: (decision: boolean) => void;
}

const defaultPromptId = (): string => crypto.randomUUID();

export const createChildPermissionBridge = (
  options: CreateChildPermissionBridgeOptions,
): ChildPermissionBridge => {
  const { channel, signal } = options;
  const newPromptId = options.newPromptId ?? defaultPromptId;
  const errSink = options.errSink ?? ((line: string) => process.stderr.write(line));

  const pending = new Map<string, PendingEntry>();
  // Three terminal states, all collapsing to "future confirmPermission
  // calls short-circuit to denial":
  //   - `disposed` flips on dispose() (caller-driven teardown)
  //   - `closed` flips on channel.onClose (peer death / EOF)
  //   - signal.aborted (read live from the AbortSignal)
  // `closed` is necessary in addition to the abort signal because a
  // peer-initiated close can land WITHOUT a hard abort — and
  // `channel.send` after close silently drops on the underlying
  // fake transport (see the IPC fake transport's "writes after
  // close are silently dropped" guarantee). Without this flag, a
  // confirmPermission call landing post-close would register a
  // pending promise, send into the void, and hang forever (the
  // peer can never reply through a closed channel).
  let disposed = false;
  let closed = false;

  // Drain every pending ask with a denial verdict. Used by the
  // dispose path AND the abort/close paths — same outcome (the
  // operator can't answer anymore, so deny is the only safe
  // verdict). Map cleared atomically to prevent re-entry from a
  // resolve callback that itself triggers another pending ask.
  const drainPendingAsDenied = (): void => {
    if (pending.size === 0) return;
    const entries = Array.from(pending.values());
    pending.clear();
    for (const entry of entries) {
      entry.resolve(false);
    }
  };

  const unsubscribeMessage = channel.onMessage((msg) => {
    if (msg.type !== 'permission:answer') return;
    const entry = pending.get(msg.promptId);
    if (entry === undefined) {
      // Race: parent answered for a promptId we already discarded
      // (channel close / dispose / abort drained it before this
      // line was framed). Drop and log — the parent's send was
      // not wrong, just late. A noisy log surface here would mask
      // the real failure mode (a buggy parent emitting fictional
      // promptIds), so the message is concise and stable.
      errSink(
        `forja: permission-bridge: unknown promptId in permission:answer (${msg.promptId})\n`,
      );
      return;
    }
    pending.delete(msg.promptId);
    entry.resolve(msg.decision === 'allow');
  });

  const unsubscribeClose = channel.onClose(() => {
    // Channel closed before parent answered. Spec §4.5 mandates
    // the channel layer survives malformed input; the bridge
    // layer mirrors that for missing input — every pending
    // resolves as denial rather than hanging forever. The child
    // harness then routes through invoke-tool's existing
    // confirm_no audit path. Flip `closed` so any
    // confirmPermission call landing AFTER the close (a tool
    // execution still queued in the harness loop when the
    // channel died) short-circuits without registering a promise
    // that would never resolve.
    closed = true;
    drainPendingAsDenied();
  });

  const onAbort = (): void => {
    // Hard-abort wakeup. Without this, a child waiting on
    // permission:answer would block past the abort signal until
    // the parent eventually answered (or never did) — defeating
    // the abort semantics invoke-tool already encoded with
    // raceAgainstAbort.
    drainPendingAsDenied();
  };

  // Skip the abort listener when the signal already fired —
  // there's nothing to drain (no pending entries yet at
  // construction) and every future confirmPermission call will
  // short-circuit on the live `signal.aborted` check inside the
  // callback. Attaching to an already-aborted signal would just
  // fire onAbort synchronously on the next tick for no
  // observable effect.
  if (!signal.aborted) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    async confirmPermission(req) {
      if (disposed || closed || signal.aborted) {
        // Nothing to send — the operator can't answer (we're
        // shutting down, the channel died, or the run was
        // aborted). invoke-tool's existing flow collapses false
        // to a denied audit row, same as every other denial
        // path.
        return false;
      }
      const promptId = newPromptId();
      // Ordering: register in `pending` BEFORE sending. If the
      // send synchronously fails (e.g., channel post-close path
      // we missed), the catch resolves the pending promise we
      // already inserted. The reverse order would have the
      // resolve callback fire before there was anywhere to
      // record it.
      const promise = new Promise<boolean>((resolve) => {
        pending.set(promptId, { resolve });
      });
      try {
        channel.send(
          makePermissionAsk({
            promptId,
            toolName: req.toolName,
            args: req.args,
            cwd: req.cwd,
            prompt: req.prompt,
          }),
        );
      } catch (e) {
        // The channel layer's `send` doesn't normally throw, but
        // a transport in a closed/error state could (e.g., the
        // process transport racing a teardown). Resolve the
        // matching promise as denial and surface the diagnostic.
        // Ordering: clean up pending before resolving so a
        // resolve callback that re-enters confirmPermission sees
        // a consistent map.
        const entry = pending.get(promptId);
        pending.delete(promptId);
        const reason = e instanceof Error ? e.message : String(e);
        errSink(`forja: permission-bridge: send failed (${reason})\n`);
        if (entry !== undefined) entry.resolve(false);
      }
      return promise;
    },
    pendingCount: () => pending.size,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeMessage();
      unsubscribeClose();
      // Best-effort signal listener removal. AbortSignal listeners
      // are auto-removed when the signal fires, but on a clean
      // dispose path the signal may still be live — leaving the
      // listener attached would keep the closure (and pending
      // map) alive longer than the bridge intended.
      signal.removeEventListener('abort', onAbort);
      drainPendingAsDenied();
    },
  };
};
