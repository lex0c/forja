# REVIEW_NOTES_R3.md

Third multi-agent code review pass — focused on the slice 125 fixes (the R2 punch list) plus slice 126's deferred-decision documentation. Four reviewers, parallel fan-out:

- R3.1 — Bash resolver (slice 125 P0-1/P0-2/P0-3 + bash P1s)
- R3.2 — Sandbox runners + hide_paths (slice 125 P0-4/P0-5/P0-6 + P1s)
- R3.3 — Doctor + storage (slice 125 P0-7/P0-8 + readonly openDb)
- R3.4 — Subagent + broker + telemetry (slice 125 P0-9/P0-10 + hierarchy + scrubbing P1s)

## Summary

**4 P0 findings + 14 P1 findings.** Pattern: the R2 fixes generally land correctly, but THREE introduce new false-refuses or fail to cover the full attack surface, AND one (subagent child sink wiring) UNMASKS a latent race condition that was hidden by the noop-sink default. Test coverage for slice 125's ~180 LoC of security logic is essentially zero — the slice claimed "+9 tests" but those are the sandbox-hide-paths fence; bash resolver / broker / hierarchy / scrubbing additions have no direct tests.

The most urgent finding: **P0-A audit chain cross-process race**. Slice 125 P0-9 wired the child engine's audit sink, which means parent + up-to-3 parallel `task_async` children all write to the same `approvals_log`. The `getLastApprovalsLogByInstall` SELECT + `appendApprovalsLog` INSERT in `audit.ts:emit` is NOT transactional — two processes can both read `prev_hash=X` and both insert with same `prev_hash`, breaking chain continuity. Pre-slice 125 this was latent (child sink was noop, only parent wrote); now it's reachable.

## P0 findings

| # | Reviewer | File | Symptom |
|---|---|---|---|
| 1 | R3.1 | `src/permissions/resolvers/bash.ts:698` | `cmdTar` GTFOBins refuse only catches standalone `-I` (`t === '-I'`); bundle form `tar -zIf prog archive` is legal and bypasses. The bundle decoder at line 761-774 inspects `c/x/t/f` but ignores `I`. Real exec vector still open. |
| 2 | R3.1 | `src/permissions/resolvers/bash.ts:1664` | `couldGlobReachProtected` does byte-wise `t.startsWith(absLiteralPrefix)`. When `cwd === $HOME`, glob `*` produces literal prefix `/home/op` (no trailing `/`); `/home/op/.ssh`.startsWith(`/home/op`) is true → refuses `ls *` / `cat *` / `find *` from `~`. High-traffic regression. cwd-relative dirs are excluded; tilde-relative dirs are NOT. |
| 3 | R3.1 | `src/permissions/resolvers/bash.ts:887,905` | ssh `-w any` (documented ssh syntax: "auto-pick tun device"). `any` has no `:`, so the portForwardFlags colon-discriminator at line 905 doesn't consume it; the loop's next iteration picks `any` as `targetIdx` → emits `net-egress:any`. Wrong host. |
| A | R3.4 | `src/permissions/audit.ts:261-292` | `getLastApprovalsLogByInstall` SELECT + `appendApprovalsLog` INSERT in `emit` is NOT wrapped in `BEGIN IMMEDIATE`/`EXCLUSIVE`. Parent + parallel `task_async` children all share install_id and write to the same `approvals_log`. Two concurrent processes can both read `prev_hash=X`, both insert with same `prev_hash` → only one row truly follows in seq order → `verifyChain` fails. Pre-slice 125 latent (child was noop sink); slice 125 P0-9 unmasks it. Fix: `withTransaction(db, () => { read+write })` wrapping. WAL writer lock + busy_timeout=5000 serializes the transactions. |

## P1 findings

### Bash resolver
- `bash.ts:336` (cmdMvCp) — `srcs = positional.filter((p) => p !== targetDir)` drops every positional textually equal to targetDir. `mv -t /tmp /tmp` makes srcs empty → conservative refuse. False-edge but visible.
- `bash.ts:1621` (expandBraces) — Numeric brace ranges (`{1..10}`, `{a..z}`) return `[arg]` unchanged. `rm /{a..z}c/passwd` bash-expands deterministically (e.g., `/ac/passwd`...`/zc/passwd` — none protected, but extend to `{e..f}{tc}/passwd` and you hit `/etc/passwd`). My code doesn't expand, doesn't refuse → bypass.
- `bash.ts:999` (cmdRsync) — `--password-file=<path>` documented daemon-password read; resolver emits no `read-fs(<path>)` for it. Operator's `~/.aws/passwords` allow rule never fires.

### Sandbox
- `sandbox-runner-macos.ts:75-80` — `escapeSbplLiteral` rejects `\n`/`\r` but NOT the full CC0/CC1 set. The same class of injection (ANSI ESC `\x1b`, BEL `\x07`, OSC sequences) lives in operator-visible strings; `welcome.ts:88-96` already strips CC0+CC1 there. The asymmetric defense is a real gap, not polish. SBPL parser's exact behavior on `\x1b]0;evil\x07` inside a literal isn't documented.
- `sandbox-runner.ts` vs `sandbox-runner-macos.ts` — tmpfs asymmetry undocumented. Linux gets fresh per-sandbox `--tmpfs /tmp`; macOS sees host `/tmp` + `/private/tmp` (real, shared, persistent). Slice 125 commentary only justifies removing `/private/var/folders`; the `/tmp` asymmetry is silent.

### Doctor + storage
- `doctor.ts:430` — Schema-mismatch detail surfaces "DB error: ...", remediation says "run `agent permission verify`". But `permission-verify.ts:55` itself calls `migrate(db, MIGRATIONS)` — the "see details" command silently UPGRADES the schema. The asymmetry hides what doctor flagged. Fix: either rename remediation or drop migrate from permission-verify.
- `doctor-cache.ts:90-100` — SessionStart cache-reset contract is documented but no caller wires it. The harness `loop.ts:1623` fires the SessionStart hook without invoking `runDoctor`; current callers (welcome, run) are one-shot. Forward-looking only; nothing test-pins the contract.

### Subagent + broker + telemetry
- `subagent-child.ts:646` — `createRecordingTelemetrySink()` is documented "test-only" in `src/telemetry/index.ts:322`. Production use accumulates events unbounded in `buffer: TelemetryEvent[]`. Long-running child = real heap pressure. Choice (recording vs noop) is implicit in slice 125's BACKLOG; doesn't acknowledge unbounded retention.
- `broker/in-process.ts:104-117` — Post-return caller-signal abort no longer propagates (documented behavioral change). No test pins the "stashed signal stays unaborted post-dispose" invariant.
- `tests/telemetry/scrubbing.test.ts` — Zero coverage for `IPV6_BRACKETED_REGEX`, `GIT_SSH_REGEX`, `DOMAIN_PORT_REGEX`. Ordering + false-positive boundary conditions unpinned.
- `tests/permissions/hierarchy.test.ts:579-594` — `stableJsonStringify` fix has no test that exercises a PROGRAMMATIC session policy with reversed key order. Both layers in existing tests go through YAML parsing which canonicalizes — the exact bug the fix addresses is untested.
- `tests/...` — No subprocess-spawning test pins P0-9/P0-10 invariants (child decisions land in chain; child telemetry doesn't drop).
- `tests/cli/doctor-cache.test.ts` — No test asserts a SessionStart-class caller gets a fresh cache. The slice 125 doc says "MUST reset"; nothing fence-tests it.

### Sandbox test coverage gaps (R3.2)
- `tests/permissions/sandbox-runner.test.ts` — no test for the new cwd-in-hide_paths refuse at `buildBwrapArgv:147-154`. Boundary `~/.ssh-backup` (sibling NOT in hide_paths) vs `~/.ssh/audit` (under) untested.
- `tests/permissions/sandbox-runner-macos.test.ts` — no test for `escapeSbplLiteral` `\n`/`\r` reject.
- `engine.ts:withSandboxProfile` `isSandboxProfile` defense-in-depth gate at line 1266-1270 has zero direct test coverage. Wire-boundary path well-tested via `maybeWrapSandboxArgv`; the symmetric engine-side gate is exercised only indirectly.

### General test-coverage gap (R3.1)
- `tests/permissions/resolvers.test.ts` — NONE of slice 125's bash resolver additions have direct tests: tar GTFOBins refuses (`--checkpoint-action=exec=`, `--use-compress-program`, `--to-command`, `-I`); rsync transport refuses (`-e`, `--rsh`, `--rsync-path`); glob/brace bypass detection (`/e{tc}/passwd`, `/e*/passwd`, `~/.s*`); ssh `-w` colon-shape, `-o LocalCommand`, `-o KnownHostsCommand`; cargo `clean`, `--target-dir`; mv/cp `-t`. ~180 LoC of security logic, 0 new resolver tests. Slice 125 BACKLOG claims "+9 tests" but those are the sandbox-hide-paths fence — bash resolver delta has no coverage.

## P2 findings

- `bash.ts:664` (cmdTar) — missing GTFOBins flags: `--rmt-command=<cmd>`, `--info-script=<cmd>` (alias `--new-volume-script`), `--owner-map=<path>`, `--group-map=<path>`. Refuse list incomplete.
- `bash.ts:683` — tar refuse messages drop canonical option spelling; ssh refuses preserve case for audit grep — asymmetry.
- `bash.ts:1658` — `couldGlobReachProtected` excludes cwdEscalateDirs but NOT tildeEscalateDirs. Same false-refuse logic as P0-2 — symmetric carve-out worth considering.
- `sandbox-hide-paths.test.ts:62-145` — Fence is one-directional. Catches new sensitive-paths entry without sandbox coverage; doesn't catch new sandbox-hide-paths entry without sensitive-paths counterpart. Acceptable asymmetry but worth a header comment.
- `sandbox-runner-macos.ts:119-140` — Operator escape-hatch lists `TMPDIR=/tmp <cmd>` but doesn't name common tools that break (`gcloud`, `aws cli`, `pip`, `xcrun`, Swift toolchain).
- `sandbox-runner.ts:149` — Defensive `cwd` normalization absent. Works correctly today but a brief comment pinning the trailing-slash invariant would forestall regression.
- `db.ts:22-29` — Docstring claims `create: false` "forced off"; code relies on Bun's default. Either pass `{ readonly: true, create: false }` explicitly or soften the docstring.
- `db.ts:24-29` (readonly path) — Docstring should note WAL semantics: readonly handle reads only committed state; concurrent writes leave uncommitted rows invisible. Harmless for chainCheck (missing last row can't flip "intact" → "broken") but worth documenting.
- `doctor.ts:392-398, 415` — `existsSync` → `openDb(readonly)` race. Catch arm surfaces "DB error: ENOENT" with misleading remediation. Either map ENOENT to "no chain yet" branch or accept.
- `subagent-child.ts:627-635` — Silent fallback to noop on `ensureInstallId` failure. Slice 125 calls it "conservative trade-off" but logs nothing to stderr — child runs invisibly to the chain with no operator signal.
- `hierarchy.ts:12-25` — `stableJsonStringify` handles `undefined` like JSON.stringify but doesn't note Symbol-keyed entries are dropped (Object.keys behavior). Polish-only since seal objects don't use symbols.

## Cross-cutting themes

1. **Test coverage gap**. Slice 125 added ~250 LoC of security logic across 7 files with effectively no targeted tests. The +9 tests claimed are the sandbox-hide-paths fence. Bash resolver (~180 LoC), broker linkSignals dispose, hierarchy canonical JSON, telemetry regex siblings, engine.ts isSandboxProfile guard — all unverified. This was the trap repeatedly avoided in slices 95-124 (each finding got its test). Slice 125 broke the pattern.

2. **False-refuses introduced by over-eager bypass detection**. P0-2 (cwd === $HOME glob), P1 expandBraces ranges, P1 sandbox cwd-in-hide_paths with trailing slash — three different shapes of "defense is too aggressive or too narrow". The glob/brace detector design needs another iteration.

3. **Latent races unmasked by enablement**. P0-A (audit chain cross-process race) was reachable in slice 95 (when subagent runtime first persisted effective capabilities) but the noop sink masked it. Slice 125 P0-9 wired the real sink; now parent + N children compete on the same DB. Pattern: enabling a previously-stubbed-out feature reveals a pre-existing concurrency assumption.

4. **Symmetric defenses introduced asymmetrically**. SBPL escape rejects CC0/CC1 partially (slice 125: only `\n`/`\r`); welcome.ts strips CC0/CC1 fully. SystemDeny + tildeEscalate + cwdEscalate get inconsistent treatment in couldGlobReachProtected. Hierarchy canonical JSON only handles the session-vs-yaml case in code (test only exercises yaml-vs-yaml).

## Triage recommendations

**Highest priority**: P0-A audit chain race. The fix is well-contained (`withTransaction` wrap in audit.ts emit) and unblocks correctness for parallel subagents. ~1 slice.

**Second priority**: P0-1/P0-2/P0-3 bash resolver fixes. P0-2 in particular is a real UX regression for any operator who runs from `~`. ~1 slice (could bundle).

**Third priority**: Test coverage for slice 125 changes. Could be a "test-fortify" slice that ports the missing assertions in (bash resolver: 12+ new tests; sandbox: 3-5 new tests; broker/hierarchy/scrubbing: 5-8 new tests). ~1 slice, large.

**Fourth priority**: Smaller P1s in functional behavior (chainCheck remediation rewording, escapeSbplLiteral CC0/CC1 expansion, audit silent fallback logging). Bundle into a single "polish" slice. ~1 slice.

P2 items can wait for a dedicated polish pass or merge into the next slice opportunistically.

---

Generated by 4 parallel review agents, 2026-05-12. Slices reviewed: 125 + 126.
