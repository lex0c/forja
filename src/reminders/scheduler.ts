// In-memory, session-scoped reminder scheduler — the SECOND producer of
// the notification channel (ORCHESTRATION.md §3B.9). Where the BgManager
// observes process exits, this observes the CLOCK: `set` arms a timer,
// and on fire the reminder is pushed into the channel (the REPL wires
// `onFire` to enqueueNotification), driving the same wake-when-idle path
// as bg_done. No SQLite, no holder pattern: unlike the BgManager it
// needs no sessionId, so the REPL builds it once at boot and injects it
// per turn like `todoStore`. Dies at session exit via `cleanup()`.

export interface Reminder {
  id: string;
  note: string;
  // Epoch ms: when it was scheduled, and when it is due to fire.
  scheduledAt: number;
  fireAt: number;
}

export interface SetReminderInput {
  // Already-parsed relative delay in ms (the tool parses "10m" → ms).
  delayMs: number;
  note: string;
}

export interface ReminderScheduler {
  set(input: SetReminderInput): { id: string; fireAt: number };
  // Pending reminders only (fired/cancelled ones are gone), soonest first.
  list(): Reminder[];
  // True if it was pending and is now cancelled; false if unknown/already fired.
  cancel(id: string): boolean;
  // Clear every pending timer — called once at session exit.
  cleanup(): void;
}

// Default horizon cap: 24h. The hard ceiling is setTimeout's 2^31-1 ms
// (~24.8 days) — a larger delay fires IMMEDIATELY (silent footgun), so a
// cap is mandatory, not cosmetic. 24h sits well under it and matches the
// session-scoped use case (a reminder outliving the session never fires).
export const DEFAULT_HORIZON_CAP_MS = 24 * 60 * 60 * 1000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface CreateReminderSchedulerOptions {
  // Fired when a reminder's timer elapses. The REPL routes this to the
  // notification channel ({ kind: 'reminder', note, scheduledAt }).
  onFire: (reminder: Reminder) => void;
  // Called after every change to the pending set (set / cancel / fire /
  // cleanup) with the new pending count. The REPL wires this to the
  // footer chip; optional so non-UI callers (tests) can omit it.
  onChange?: (pendingCount: number) => void;
  // Injectable clock + timer for deterministic tests; default to the
  // platform globals. A fake lets a test fire reminders synchronously
  // without waiting wall-clock.
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  horizonCapMs?: number;
}

interface Entry {
  reminder: Reminder;
  handle: TimerHandle;
}

export const createReminderScheduler = (
  options: CreateReminderSchedulerOptions,
): ReminderScheduler => {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  const horizonCap = options.horizonCapMs ?? DEFAULT_HORIZON_CAP_MS;
  const entries = new Map<string, Entry>();
  const notifyChange = (): void => options.onChange?.(entries.size);

  const set = (input: SetReminderInput): { id: string; fireAt: number } => {
    const { delayMs, note } = input;
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      throw new Error(
        `reminder: delay must be a positive finite number of ms (got ${String(delayMs)})`,
      );
    }
    if (delayMs > horizonCap) {
      throw new Error(`reminder: delay ${delayMs}ms exceeds the ${horizonCap}ms horizon cap`);
    }
    const id = crypto.randomUUID();
    const at = now();
    const reminder: Reminder = { id, note, scheduledAt: at, fireAt: at + delayMs };
    const handle = setTimer(() => {
      // Drop the entry BEFORE onFire: a re-entrant list()/cancel() from
      // the fire callback then sees it already gone, and a stray
      // double-fire can't double-enqueue.
      entries.delete(id);
      notifyChange();
      options.onFire(reminder);
    }, delayMs);
    entries.set(id, { reminder, handle });
    notifyChange();
    return { id, fireAt: reminder.fireAt };
  };

  const list = (): Reminder[] =>
    [...entries.values()].map((e) => e.reminder).sort((a, b) => a.fireAt - b.fireAt);

  const cancel = (id: string): boolean => {
    const e = entries.get(id);
    if (e === undefined) return false;
    clearTimer(e.handle);
    entries.delete(id);
    notifyChange();
    return true;
  };

  const cleanup = (): void => {
    for (const e of entries.values()) clearTimer(e.handle);
    entries.clear();
    notifyChange();
  };

  return { set, list, cancel, cleanup };
};
