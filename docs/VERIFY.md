# Forja Verify-Gate Operator Guide

This document describes Forja's **claim-time verification gate**: an opt-in check that, before a run is allowed to declare it is done, requires the agent to have actually run the project's verification commands after editing code. It is for operators who want "don't claim done without running the tests" enforced, and for contributors extending the harness.

The canonical specification lives in `docs/spec/STATE_MACHINE.md §3.2.1` (PT-BR). This document is the English-language operational reference; when the two diverge, the spec wins.

---

## 1. What it is

When the model finishes a turn with a final answer and **no tool calls** (a "claim"), the harness runs a deterministic, opt-in gate before accepting it. If the run **edited a file** but has **not** run every declared verify command (with exit 0) **since the last edit**, the harness:

1. **suppresses** the answer,
2. appends a synthetic nudge naming the commands the model still owes, and
3. **re-generates** — the model runs the commands (it runs them, the harness never does) and then re-answers.

This is "measure twice, cut once" applied at *claim time*: accepting a final answer that edited code without running the verification is cutting without measuring.

It is a **nudge, not a hard trap**: after `MAX_VERIFY_ATTEMPTS` (2) nudges the gate accepts the answer anyway (and leaves a stderr trace). It never blocks a run forever and never creates a new terminal state.

---

## 2. Configuring it

The gate is **off by default**. Turn it on by declaring the commands in `.forja/config.toml` (project or user layer; project wins):

```toml
[verify]
commands = ["bun run typecheck", "bun test"]
```

- **Empty or absent** `commands` ⇒ gate off.
- An explicit `commands = []` ⇒ gate off (project can override an inherited user gate this way).
- **Fail-soft** (mirrors `[sandbox]`): a malformed value (not a list, or no usable string entries) leaves the gate **off** and warns on stderr — a typo never half-enables a gate. Non-string / empty entries are dropped with a warning.

The config flows to the harness as `HarnessConfig.verify.commands` (`src/config/loaders.ts` `loadVerifyConfig` → `src/cli/bootstrap.ts`). It also threads into **subagents** (`src/cli/subagent-child.ts`), so a delegated edit gates its own claims rather than slipping past the gate.

---

## 3. How "verified" is decided (deterministic)

The gate reads only **structured runtime facts**, never the model's prose — the deliberate lesson from the removed regex-over-prose `ProjectVerifier` (which couldn't tell an assertion from a historical mention). State lives in `src/harness/verify-gate.ts`:

- **"The run edited a file"** — a *settled, successful* call to `write_file`, `edit_file`, or `git_apply_patch` (`FILE_WRITER_TOOLS`). A denied or failed write does not count.
- **"A verify command passed"** — a foreground `bash` call whose `command` matches a declared command and that **exited 0**. (Exit code comes from the real tool result; a non-zero exit does not count.)
- **"…since the last edit"** — every new file edit **invalidates** prior verify evidence, so a verification only counts if it post-dates the last change.

**Command matching is EXACT** (`matchesVerifyCommand`): the whitespace-collapsed bash command must *equal* the declared command, either as the whole command or as one `&&` / `||` / `;` / `|` / newline segment (so `cd app && bun test` credits a declared `bun test`). It is intentionally **not** a prefix/substring match — that would let a no-op sibling (`bun test --help`) or a mention in a quoted string (`git commit -m "...; bun test"`) satisfy the gate without the tests running. The cost of exactness is that the model must run the declared command **without a leading wrapper** (`CI=1`, `time`); the nudge names the exact command, and the retry bound caps the cost.

---

## 4. Known limits

- **Bash-driven edits are a blind spot.** Only the three structured writers count as an edit. A file changed through `bash` (`sed -i`, `> file`, `git apply`, `tee`) is not tracked — `bash`'s write path is unknowable from its input (the same reason recap files it under commands_run, not filesWritten). Detecting bash writes deterministically isn't feasible without command/prose heuristics, which this design avoids. The encouraged edit path — the structured tools — is covered.
- **Exact match is strict** (see §3). A model that habitually wraps the command (`CI=1 bun test`) will be nudged until it runs the bare form, then accepted on exhaustion.
- **No structured audit event yet.** A block is visible in the message log (the nudge is a persisted turn); exhaustion leaves a stderr line. The structured `verify_gate_exhausted` event + its TUI rendering is a tracked follow-up (`docs/TODO.md` H3.6).

---

## 5. Why it is opt-in (not default-on)

The gate ships **off** by design:

- **There is no universal default command.** The gate is driven by a project-specific command list (`bun test`, `cargo test`, `pytest`, …); "default on" would require either a list that doesn't exist or auto-detecting the command from `package.json`/`Cargo.toml`/… — the heuristic-inference path the design deliberately avoids.
- **Measured cost, unmeasured value.** The `evals/verify-gate` A/B (opus-4.8 + an Ollama-Cloud coder, 2/2 each) showed the gate is **safe** (task success preserved) and that a real model **complies** with the nudge (runs the command, end to end) — but the ON arm cost **~2.4×** the OFF arm (the extra nudge→verify→re-answer cycle), and the edits were correct, so it confirmed correct edits rather than catching a broken claim. The value (how often it catches a premature "done") is unmeasured; the cost is paid on every edit session.
- **Opt-in is the premise applied to the feature itself.** An operator who declares `verify.commands` has consciously decided the verification tax is worth it for their project — and knows the right command.

To justify flipping the default later you would want (a) a deterministic answer for "which command" without heuristics, and (b) an eval showing the gate catches broken claims often enough to pay the ~2.4× tax.

---

## 6. Verifying it works

A self-contained A/B probe lives in `evals/verify-gate/` (an identical buggy-edit task; only the ON arm ships a `[verify]` config, so any delta is the gate's effect):

```
bun run eval:verify-gate            # opus-4.8
bun run src/evals/cli.ts evals/verify-gate --model ollama/qwen3-coder:480b
```

The behavioral signal: if the run prints `forja: verify gate accepted an unverified answer …` the model **ignored** the nudge (gate exhausted); if it doesn't (and the ON arm takes more steps than OFF) the model **ran** the declared command after the nudge.

Deterministic coverage: `tests/harness/verify-gate.test.ts` (matching incl. the false-positive regressions, mutation/verify state transitions, the nudge) and the gate-integration cases in `tests/harness/loop.test.ts` (off → no re-nudge; block → re-nudge → accept after max; a passing verify satisfies it with no re-nudge).
