# Forja TUI Architecture

This document describes how Forja's terminal UI is built: the data flow, the
state model, and the render pipeline. It is **not** a layout guide (what goes
where on screen) — it explains *how the layout is rendered and how state
updates propagate*. It is for contributors working on `src/tui/`.

The canonical specification lives in `docs/spec/UI.md` (PT-BR). This document is
the English-language architecture reference; when the two diverge, the spec
wins.

No UI framework is used. The TUI is raw ANSI + raw stdin, inline-rendered (the
locked stack, CLAUDE.md). Everything below is built from the runtime and a
couple of leaf deps (`string-width`).

---

## 1. The shape: event-sourced, unidirectional

The TUI is an **event-sourced** system with a **pure reducer** and a
**differential renderer**. State is never mutated in place by the UI; it is a
fold over a stream of events, and the screen is a projection of that state.

```
            ┌──────────────────────── producers ────────────────────────┐
 harness ── HarnessEvent ── adapter.translate() ── UIEvent[] ─┐
 keyboard ─ stdin ─ keys.ts ─ focus-stack ─ input-editor ─ bus.emit(input:update,…) ┤
 modals ─── modal-manager.ask*() ───────────────── bus.emit(*:ask) ───────────────────┤
                                                                                       ▼
                                                                                  Bus (one channel)
                                                                                       │ onAny
                                                                                       ▼
                                                              renderer.handleEvent(event)
                                                                       │
                                            applyEvent(state, event) ──► { state', permanent[] }
                                                                       │                     │
                                                  composeLive(state') ─┤                     └─► scrollback
                                                  (live region rows)   │                         (formatPermanent)
                                                                       ▼
                                                  diff + single write ──► terminal
```

One direction only: **producers emit events → the reducer folds them into state
→ the renderer projects state into rows**. Nothing mutates the screen directly.

The three foundational properties this buys:

- **Testable.** The reducer is pure (`applyEvent`), so state transitions are
  unit-tested with no terminal.
- **Replayable.** Because state is a fold over events, a session can be
  reconstructed deterministically (resume / audit).
- **Single-writer.** Only the renderer writes the live region to stdout;
  scrollback is append-only above it. No two owners of the same screen space.

---

## 2. The event bus (`bus.ts`)

A thin typed wrapper over Node's `EventEmitter`. One logical channel: every
event is emitted on both its **type channel** (for `on(type, …)` subscribers)
and a wildcard `__any__` channel (for `onAny`).

- The renderer subscribes via `bus.onAny(handleEvent)` — it sees every event.
- An NDJSON serializer can also `onAny` to forward the stream to stdout (`--json`
  mode).
- Delivery order matches emit order (synchronous `EventEmitter`).

There are **no extra reactive deps** (mitt / RxJS / nanoevents); the API surface
needed is tiny and the spec bans extra deps. One quirk handled: Node throws on
`emit('error', …)` with no `'error'` listener, so the bus skips the typed-channel
emit for `error` events when nobody is on that channel (`onAny` still receives
them).

`UIEvent` is a discriminated union of ~58 variants (`events.ts`) —
`session:start`, `assistant:start/delta/end`, `thinking:*`, `tool:start/
execution-started/delta/end`, `provider:waiting:*`, `input:update`,
`user:submit`, `slash:update`, `reverse-search:*`, `*:ask` (modals), etc.

---

## 3. Producers

Two sides feed the bus.

### 3.1 The harness adapter (`harness-adapter.ts`)

The agent loop (`runAgent`) streams `HarnessEvent`s via `cfg.onEvent`. The REPL's
`onHarnessEvent` (`cli/repl.ts`) calls `adapter.translate(event)`, which converts
**one** `HarnessEvent` into **0..N** `UIEvent`s, then emits each on the bus.

The adapter is the boundary that isolates the renderer from harness semantics:
`tool_invoking → tool:start`, `tool_finished → tool:end`, `session_finished →
session:end`, provider stream events → `assistant:*` / `thinking:*`, etc. It also
does display-time normalization — e.g. it flattens a multi-line tool subject to a
single line (a raw newline in a live row would break the one-row-per-element
invariant; see §7).

### 3.2 The input pipeline (`keys.ts` → `focus-stack.ts` → `input-editor.ts`)

Raw stdin (TTY raw mode) is parsed by `keys.ts` into `KeyEvent`s (printable
codepoints, control bytes, CSI/SS3 escape sequences, bracketed-paste markers).
Each keystroke is dispatched through the **focus stack**: the top handler runs
first; if it returns false (didn't consume), the next one down gets a chance.

- The **input editor** (`input-editor.ts`) is a pure `(KeyEvent, InputState) →
  { state, signals }` reducer. It emits `input:update` (buffer changed),
  `user:submit` (Enter on non-empty), interrupt/cancel signals, etc., which the
  REPL turns into bus events.
- The **modal manager** (`modal-manager.ts`) pushes a focus handler when a modal
  opens, so modal input shadows the editor cleanly without the editor knowing
  about modals. Its `ask*()` methods emit a `*:ask` event (the reducer renders
  the modal) and return a promise that resolves with the user's answer.

Key point for §4: input events (`input:update`, `slash:update`, reverse-search)
flow through the **same bus** as harness events, so the renderer treats them
uniformly.

**Input prefixes (`/` and `!`).** The first character of the buffer selects a
mode that the input render reflects and the REPL dispatch routes:

- `/command` — slash command. `render/input.ts` paints the command token blue;
  Enter dispatches it through the slash registry (not the agent).
- `!command` — operator shell escape. The leading `!` becomes the prompt glyph
  (`> ` → `! `), the whole line + its rules render yellow, and the footer
  collapses to `! for shell mode`. Enter runs it as the operator's **own shell**
  (`bash -c` in the cwd, full env) — NOT through the agent's permission engine or
  sandbox; the engine gates the agent, not the human. The result lands in
  scrollback as an `operator-bash` card (`operator-bash:done` → reducer →
  `formatPermanent`). Its hardening (all in `cli/repl.ts`):
  - **Gating** — the bash-mode visuals key off `state.busy` (the renderer's
    mirror of the REPL's `isBusy()`, pushed via `busy:change`), the *same*
    predicate the submit path uses, so they never show for a `!` that Enter would
    refuse (a turn / playbook / another `!cmd` in flight). `render/mode.ts`
    centralizes the predicate so input / rules / cursor / footer can't desync.
  - **Output safety** — sanitized at intake before `operator-bash:done`: ANSI +
    C0/C1/DEL stripped and `\r` normalized to `\n` (else a `!cat untrusted-file`
    could clear the screen, hide the cursor, or overwrite the frame margin).
    Drained with a 1 MiB **byte cap** (memory guard against `!yes` / huge files)
    and a 200-line **display cap**.
  - **Lifecycle** — runs `detached` so the timeout / interrupt SIGKILLs the whole
    process group. Ctrl+C / Esc interrupt it (SIGINT then SIGKILL on a repeat) via
    a kill switch the executor hands up. The promise is tracked so shutdown kills
    + awaits it (no orphan, no emit after teardown). The executor exposes the kill
    switch one microtask after `operatorBashRunning` flips, so an interrupt or a
    quit landing in that window (same stdin burst) is **replayed** when the hook
    registers — `if (exiting) SIGKILL` else `if (interrupted) SIGINT` — otherwise
    the pre-registration `kill?.()` no-ops and the command runs to its timeout.
    The read loop races each chunk against `proc.exited`: when the FOREGROUND
    shell exits it stops blocking on stream EOF (a `&`-backgrounded child inherits
    and holds the pipe open) and does a short bounded flush of buffered output,
    then returns — the detached child lives on like a shell `&` job. Exactly one
    `reader.read()` is ever outstanding (the pending promise is carried across
    races, only wrapped with a discriminant) so chunks are never reordered/dropped.
  - The render and the cursor (`composeCursor`) both strip the leading `!` so the
    caret stays aligned — a shared contract, like the wrap chunker.

---

## 4. State + reducer (`state.ts`)

A single immutable `LiveState` snapshot holds everything the live region needs:
the input buffer, `activeTools` (a `Map` keyed by toolId), `pendingAssistant`,
`thinking`, `awaitingProvider`, `currentTurnId`, `busy` (a mirror of the REPL's
`isBusy()`, pushed via `busy:change` — the render layer can't call `isBusy()`,
so this is how the bash-mode gate matches the submit gate), `todos`,
`subagents`, `bgProcesses`, the modal, the slash popover, the reverse-search
overlay, status fields, and `pendingToolEndBatch` (the tool coalescing buffer).

The heart is:

```ts
applyEvent(state: LiveState, event: UIEvent): { state: LiveState; permanent: PermanentItem[] }
```

**Pure** — no I/O, no timers, no `Date.now`. Every event yields two outputs:

1. **`state'`** — the next snapshot, which feeds the **live region**.
2. **`permanent[]`** — zero or more `PermanentItem`s that become **scrollback**.

`applyEvent` is a thin wrapper over `applyEventInner` (the pure switch). The
wrapper localizes one cross-cutting concern: flushing `pendingToolEndBatch`
(§6.2) when an event emits a permanent, so the coalescing buffer logic lives in
one place instead of being threaded through every case.

### The two output planes

This is the central distinction in the whole TUI:

| Plane | Lifetime | Produced by | Written |
|---|---|---|---|
| **Live region** | ephemeral, redrawn every frame | `composeLive(state)` → `string[]` (one row per element) | erased + redrawn in place |
| **Scrollback** | permanent, append-only | `formatPermanent(item)` per `PermanentItem` | written once, scrolls up forever |

`PermanentItem` kinds: `user-submit`, `assistant`, `tool-end`, `tool-end-batch`,
`session-banner`, `session-footer`, `warn`, `error`, `info`, `operator-bash`,
`recap-terse`. The
reducer decides what is scrollback (by emitting it in `permanent[]`); the
renderer never makes that call.

---

## 5. Rendering the live region (`render/compose.ts`)

`composeLive(state, caps, now) → string[]` projects the state into the live
region as **an array where each element is exactly one terminal row**. Top to
bottom:

1. TodoList
2. Subagent rows
3. Live tool-end batch preview (accumulating, grouped finalizations — §6.2)
4. Active tool cards (running)
5. Pinned turn-phase chip (Awaiting → Thinking → Generating → Orchestrating)
6. Bottom anchor (rule / input / rule / footer), or a modal that owns the slot

Each section delegates to a leaf render function in `render/` (`todo-list.ts`,
`subagent-row.ts`, `tool-card.ts`, the chip files, `footer.ts`, `input.ts`,
`modal.ts`, …). Leaf functions emit **unpadded** rows; `compose` applies the
frame margin (`padFrame`, `render/frame.ts`) so leaves stay composable.

`composeCursor(state, caps, lineCount)` is the companion: it computes where the
terminal caret should land inside the live region (the input row/column),
anchored from the bottom (`lineCount − trailingBelowInput − inputLineCount`).
Column and wrapping are **visual-width aware** (`render/wrap.ts` +
`render/width.ts`), so CJK / emoji (2 columns) advance the caret correctly.

Formatting policy lives entirely in `render/`: glyphs (`glyphs.ts`), color/SGR
and capabilities (`term.ts`), spinner animation, the shimmer sweep
(`shimmer.ts`), Markdown settling (`markdown.ts`), width math (`width.ts`).

---

## 6. The renderer (`renderer.ts`)

Mechanics only — the renderer knows about bytes, cursor moves, and diffing; it
holds **no** formatting decisions. It owns the redraw cycle and the live-region
↔ scrollback handoff.

### 6.1 The per-event loop

```
bus.onAny ─► handleEvent ─► (hold gate) ─► processEvent
                                                │
                              state = applyEvent(state, event)
                                                │
                  permanent.length > 0 ? writeTransition(permanent)   // erase live, write scrollback, redraw live
                                        : scheduler.request()          // coalesced live-only redraw
```

- `processEvent` is the unconditional apply path: fold the event, then either
  emit scrollback (`writeTransition`) or schedule a live redraw.
- `handleEvent` is the gate in front of it (see §6.3 — the tool min-display
  hold). Keystroke / overlay events bypass the gate so typing stays responsive.

### 6.2 The three draw paths

`redraw()` calls `composeRows()` (= `composeLive` then split any embedded
newline — see §7), truncates each row to `caps.cols`, and picks one of:

- **Full draw** (`buildFullDraw`) — first frame, height change, or after a
  scrollback transition. Writes every row; sets `liveHeight` / `cursorRow`.
- **Differential draw** (`buildDifferentialDraw`) — same height. Walks to row 0,
  compares `truncated[i]` to `prevLines[i]`, and **re-emits only changed rows**.
  This is the anti-flicker core: under key repeat only the input row changes, so
  the surrounding static rows (rules, footer, cards) are never repainted.
- **Erase only** — empty live region.

**Erase mechanics** (`buildErase`): `\r` (column 0) + `cursorUp(cursorRow)`
(walk to row 0 of the live region) + `clearDown` (wipe everything below). The
scrollback emit path (`writeTransition`) does erase → write permanent → full
redraw, so a finalized item moves out of the live region and up into scrollback.

Each redraw is a **single `write()`** wrapped in **synchronized output
(DECSET 2026)** so supporting terminals present the frame atomically (no
tearing). The single-write + sync-output + differential triple is what keeps the
live region stable under 30fps key repeat across both modern and older emulators.

### 6.3 Pacing: scheduler and heartbeat

- **Frame scheduler** (`term.ts`, `createFrameScheduler`) coalesces multiple
  `request()` calls into ≤1 render per frame (~33ms / 30fps). Timer-injectable
  for deterministic tests.
- **Heartbeat** (`heartbeat.ts`) ticks `scheduler.request()` while *anything
  animates* (a running tool, the thinking/elapsed counter, the awaiting chip).
  Without it the spinner would freeze between events. It idles when nothing
  animates — zero wakeups while waiting on input.
- **Tool min-display hold** (renderer-level, off by default, 400ms in
  production). Fast tools (read / write / quick bash) complete inside one frame
  budget; by the time the coalesced frame draws, the reducer has already removed
  the tool, so the card never paints. The hold buffers a `tool:end` (and the
  harness events queued behind it) until the card has been on screen at least
  `toolMinDisplayMs`, keeping it visible (and animating via the heartbeat).
  Events in `HOLD_BYPASS` skip the queue — three categories that would BREAK if
  delayed: **keystroke/overlay** (typing stays responsive), **modal open +
  lifecycle** (`modal-manager` installs the focus handler synchronously, so the
  modal must render in lockstep — else a hidden permission prompt, defaulting to
  Yes, could be answered unseen), and **interrupt** (`triggerInterrupt` reads the
  flipped `softInterrupted` for the soft→hard ladder). All bypassed events emit
  no permanent, so processing them out of order with the held `tool:end` is
  scrollback-safe.

### 6.4 Tool grouping (coalescing + live preview)

Consecutive same-name tool finalizations buffer into `pendingToolEndBatch`
(reducer) and, at/above a threshold, settle into a single coalesced
`● Executed N commands` summary instead of N separate blocks. The accumulating
buffer is **rendered live** (compose §5 step 3) through the *same*
`formatPermanent` the scrollback path uses, so completed tools stay visible and
grouped until they settle — and when they flush, the block simply moves from the
live region into scrollback with no visual jump.

---

## 7. Core invariants

These are load-bearing; breaking one causes ghost rows or caret drift.

1. **One array element = one terminal row.** `liveHeight`, `cursorRow`, the
   erase walk-back, and the differential diff all count array elements as rows.
   - **Newlines:** a string with an embedded `\n` would span two terminal rows
     as one element. Guarded at two layers: subjects are flattened at the adapter
     (§3.1), and `composeRows()` splits any embedded `\n` before counting — the
     single chokepoint for every source.
   - **Width:** a row wider than `caps.cols` would soft-wrap into two terminal
     rows. Non-input rows are clamped by `truncateToWidth` (visual-width aware).
     The input is wrapped by **visual width** (`wrapInputLine`), so each emitted
     input row fits within `caps.cols`.
2. **Visual width, not code units.** `width.ts` (`string-width`) measures CJK /
   emoji as 2 columns; `wrapInputLine` and `composeCursor` both use it. UTF-16
   `.length` would undercount and drift the caret / erase math.
3. **Pure reducer.** `applyEvent` has no I/O or time. All timing (hold,
   scheduler, heartbeat) lives in the renderer; all formatting lives in
   `render/`.
4. **Single-writer.** Only the renderer writes the live region; scrollback is
   append-only above it.

---

## 8. Terminal capability + degradation (`term.ts`)

`detectCapabilities()` reads the environment, never probes:

- **TTY** gates interactivity (`stdout.isTTY`).
- **Color** — `NO_COLOR` disables; `CLICOLOR_FORCE=1` forces; else TTY-gated.
  Palette is 16-color SGR plus bright-black (90) / blue (94, 34); `secondary`
  uses SGR 90 (universally visible) rather than SGR 2 (faint, invisible on many
  configs).
- **Unicode** — conservative, locale-based (`UTF-8` in `LC_ALL`/`LC_CTYPE`/
  `LANG`). Otherwise ASCII-glyph fallback (`render/glyphs.ts`, spinner `|/-\`).

Private modes (DECSET 2026 synchronized output, 2004 bracketed paste) are emitted
unconditionally — terminals that don't support them ignore them silently, so
there is no garbage on unsupported emulators. The rest of the output is standard
VT100/ANSI (`CSI A/B/C/D`, `\r`, `CSI J`, `CSI 2K`, SGR), which works everywhere.

**Known limits:** there is no `TERM`/terminfo gating and no real-terminal CI
matrix; emoji/wide-glyph width depends on `string-width` agreeing with the
emulator (a perennial TUI hazard), and tmux/screen can filter some modes. The
design degrades gracefully rather than guaranteeing pixel-identical output across
every emulator.

---

## 9. Testing model + gaps

Unit tests drive the bus with a fake `write` sink and injected timers/`now`, and
assert on the captured byte stream or `renderer.state()`. This covers reducer
logic, compose output, the diff/erase sequences, the hold, coalescing, and width
math.

**The gap:** the fake sink does not model the real terminal's behavior (it does
not soft-wrap on `\n` or on over-width rows). So the *one-element-per-row*
invariant (§7.1) cannot be observed end-to-end in a string test — a violation
looks identical in the captured buffer and only manifests on a real terminal as a
ghost row. That class of bug is caught by `bun run dev` today; the highest-value
coverage improvement would be a pty-backed test that compares a real framebuffer.

---

## 10. Module map

| Module | Role |
|---|---|
| `bus.ts` | Typed event bus (single channel, `onAny`). |
| `events.ts` | `UIEvent` discriminated union (~58 variants). |
| `state.ts` | `LiveState`, the pure `applyEvent` reducer, `PermanentItem`, batch coalescing. |
| `renderer.ts` | Redraw cycle: draw paths, erase, scheduler/heartbeat wiring, tool-display hold, scrollback handoff. |
| `renderer-types.ts` | Shared `ComposeLive` type (breaks the renderer ↔ compose import cycle). |
| `term.ts` | Capability detection, ANSI/SGR primitives, frame scheduler, raw-mode toggles. |
| `heartbeat.ts` | Animation ticker — requests frames while something animates. |
| `harness-adapter.ts` | `HarnessEvent` → `UIEvent[]` translation; display-time normalization. |
| `tool-vocab.ts` | Per-tool verbs + subject extractors (`bash → Executing/Executed`, …). |
| `keys.ts` | Raw-stdin escape-sequence parser → `KeyEvent`. |
| `focus-stack.ts` | Keystroke dispatch stack (modal input shadows editor input). |
| `input-editor.ts` | Pure key-event reducer for the input buffer. |
| `modal-manager.ts` | Async `ask*()` API ↔ bus `*:ask` events ↔ focus stack. |
| `index.ts` | Public surface (re-exports). |
| `render/compose.ts` | `composeLive` (live rows) + `composeCursor` (caret position). |
| `render/permanent.ts` | `formatPermanent` — `PermanentItem` → scrollback rows. |
| `render/width.ts` | Visual width + `truncateToWidth` (wraps `string-width`). |
| `render/wrap.ts` | `wrapInputLine` — visual-width-aware input soft-wrap chunker. |
| `render/frame.ts` | `padFrame` — frame margin for live rows. |
| `render/mode.ts` | `isBashMode` — shared bash-mode predicate (single source of truth for input / rules / cursor / footer; gated on `state.busy`). |
| `render/glyphs.ts` | Unicode/ASCII glyph pairs (connectors, spinner, ellipsis). |
| `render/shimmer.ts` | Highlight-sweep animation for live verbs. |
| `render/spinner-verbs.ts` | Cognitive / output / tool verb pools + deterministic pickers. |
| `render/{thinking,assistant,awaiting,tool-phase}-chip.ts` | The four pinned turn-phase chips. |
| `render/tool-card.ts` | Live (running) tool card. |
| `render/{todo-list,subagent-row,footer,input,modal,slash-popover,reverse-search,inbox,markdown,duration}.ts` | The remaining live + scrollback elements. |

---

## 11. Worked example: one turn

1. `user:submit` → reducer echoes the prompt as a `user-submit` permanent (turn
   boundary in scrollback); the REPL starts the harness run.
2. `provider:waiting:start` → `awaitingProvider` set → pinned chip shows
   `Awaiting model…` (heartbeat ticks the elapsed counter).
3. `thinking:start/delta/end` → pinned chip shows a cognitive verb
   (`Synthesizing…`); `currentTurnId` is anchored.
4. `assistant:start/delta` → `pendingAssistant` set → chip shows an output verb
   (`Forging…`); streamed text accrues in the buffer.
5. The model emits tool calls → `tool:start` (card appears, held ≥400ms),
   `tool:execution-started`, `tool:end` (buffers into the batch; the live preview
   shows `● Executed N commands` growing); the pinned chip shows `Orchestrating…`
   while the model is idle.
6. `assistant:end` with text → flushes the batch to scrollback (grouped) and
   lands the assistant prose.
7. `session:end` → flushes any remaining batch, emits the `session-footer`
   (`Cogitated for Xs`), clears per-turn state; the input box returns.
