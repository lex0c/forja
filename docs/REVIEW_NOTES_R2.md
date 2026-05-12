# REVIEW_NOTES_R2.md

Second multi-agent code review pass over slices 95-124 (the post-REVIEW_NOTES.md hardening sprint). Five reviewers, parallel fan-out:

- R2.1 — Bash resolver (slices 97, 98, 100, 120)
- R2.2 — Broker contract + handlers (slices 102-117, 121)
- R2.3 — Sandbox runners + hide_paths (slices 103, 118, 119)
- R2.4 — CLI surface — doctor / welcome / sandbox-skip (slices 109, 122-124)
- R2.5 — Subagent + replay + telemetry + sealing (slices 94-96, 99, 111, 112)

## Summary

**10 P0 findings + 17 P1 findings.** No reviewer flagged a regression against earlier slices; the failures listed below are gaps that existed pre-slice OR that slipped past the slice's review scope.

Two patterns recur:
1. **GTFOBins via flag values** (R2.1 P0-1, P0-2): tar/rsync admit arbitrary local exec through documented flag values that the resolver treats as plain path args. Symmetric to ssh's `ProxyCommand` refuse pattern (slice 120) but missing for the other commands.
2. **Drift between two canonical "credential paths" lists** (R2.3 P0-2): `sandbox-hide-paths.ts` (slice 119) and `src/subagents/sensitive-paths.ts` both declare credential paths and have already diverged — `.git-credentials` is in the latter but not the former.

## P0 findings

| # | Reviewer | File | Symptom |
|---|---|---|---|
| 1 | R2.1 | `src/permissions/resolvers/bash.ts:618-716` | `tar --checkpoint-action=exec=<cmd>` / `--use-compress-program=<cmd>` / `--to-command=<cmd>` pass through unchecked. Documented GTFOBins. cmdTar emits ordinary tar shape; no `exec:arbitrary` attribution. Narrow `tar` allow rule admits arbitrary local exec. |
| 2 | R2.1 | `src/permissions/resolvers/bash.ts:898-942` | rsync `-e <cmd>` / `--rsh=<cmd>` / `--rsync-path=<cmd>` allow arbitrary local/remote shell. Per `man rsync` `-e` is literally exec'd as transport. Comment acknowledges but only flips confidence; should be hard refuse like ssh's `ProxyCommand`. |
| 3 | R2.1 | `src/permissions/resolvers/bash.ts:271-302, 304-312, etc.` | Shell glob/brace expansion bypasses `classifyProtectedPath`. `rm /e*/passwd` and `rm /e{tc}/passwd` resolve to literal strings, neither matches `/etc` deny tier; tree-sitter packs as single `word`/`concatenation`; runtime shell expands at exec. No defense. |
| 4 | R2.3 | `src/permissions/sandbox-runner.ts:147` | `--bind <cwd> <cwd>` (Linux) follows symlinks. If cwd contains a symlink pointing outside cwd (e.g., `node_modules → shared cache`, `.cache → ~/.aws/sso/cache`), the inner process writes through the link to host paths outside the declared sandbox boundary. Engine §4.3 `symlink_escape` deny exists at engine layer but runtime sandbox doesn't enforce. |
| 5 | R2.3 | `src/permissions/sandbox-hide-paths.ts:20-37` | Coverage gap vs real credential surfaces. Missing: `.git-credentials` (already in `src/subagents/sensitive-paths.ts:53` — **the two lists have drifted**), `.aws/sso/cache/` (AWS SSO token cache; survives even when `~/.aws/credentials` is empty), `.config/azure/`, `.terraform.d/credentials.tfrc.json`, `.config/op` (1Password CLI), `.config/sops`, `.ansible/cli.cfg`. |
| 6 | R2.3 | `src/permissions/sandbox-runner-macos.ts:107-110` | `(allow file-write* (subpath "/private/var/folders"))` grants write to the entire per-user TMPDIR root, which on macOS includes `com.apple.Keychain.*` ephemeral state, `com.apple.security.*` caches, credential-helper sockets. Linux equivalent uses `--tmpfs /tmp` (fresh isolated tmpfs); macOS just unlocks the host path. |
| 7 | R2.4 | `src/cli/doctor.ts:402` | `chainCheck` leaks the SQLite handle on every invocation. `openDb(options.dbPath)` opened inside try block; no `db.close()` on any path. Under §13.8 harness re-runs doctor every 50 tool calls; a 1000-call session leaks ~20 WAL connections + WAL/SHM files. |
| 8 | R2.4 | `src/cli/doctor.ts:403` | `chainCheck` silently mutates the operator's DB by running `migrate(db, MIGRATIONS)`. Doctor health check is now an unaudited schema-write surface — spec philosophy §13.1 "detect, don't distribute" broken. Should open read-only or assert schema currency without writing. |
| 9 | R2.5 | `src/cli/subagent-child.ts:612-617` | Child engine constructed without an `audit` sink. Engine defaults to `createNoopSink()`; child engine decisions never enter `approvals_log` chain. §17 replay surface AND §7.2 chain integrity coverage are silent for every child session. |
| 10 | R2.5 | `src/cli/subagent-child.ts:1052-1070` | Child engine constructed without a `telemetry` sink either. Slice 111 wired telemetry into the parent harness only; child harness's `loop.ts:901` emit short-circuits on `undefined` telemetry. `SandboxDegradedActiveEvent`, `permission.decision`, `classifier.unavailable`, `state.transition` from children all silently drop. |

## P1 findings

### Bash resolver
- `bash.ts:769` — ssh `-w` classified as numeric-value but accepts colon-shape `local_tun:remote_tun` (e.g., `-w 0:1`). Colon-shape survives as a `word` and gets picked as host. Emits `net-egress:0:1`.
- `bash.ts:743-750` — ssh `-o` denylist only covers `ProxyCommand`. `LocalCommand`, `KnownHostsCommand`, `PermitLocalCommand` all spawn local shell when configured.
- `bash.ts:971-1004` — `cargo clean` emits write-fs without delete-fs; `cargo build --target-dir=<other>` misattributes the build dir.
- `bash.ts:314-324` — cmdMvCp ignores GNU `-t target` / `--target-directory=`. `mv -t /etc src1 src2` treats `/etc` as source. Per-arg classifier still fires on `/etc` but the emitted write-fs scope is wrong.

### Broker
- `in-process.ts:78-90` — `linkSignals` real listener leak on caller-signal when master never aborts. `{once:true}` only auto-removes on fire; non-firing signal carries one extra listener per call indefinitely if broker outlives caller signal.
- `in-process.ts:154-165` — `timeoutMs` timer cleared but `timeoutCtrl` listener on `baseSignal` NOT removed on natural completion. One listener per call accumulates on the master signal until shutdown.
- `safe-json.ts:74-98` — `scrubProtoPollution` skips Map/Set/symbol-keyed entries. After `JSON.parse` these can't appear, but in-process broker accepts already-parsed `BrokerRequest.args` from the SDK; docstring overstates coverage.
- `spawn.ts:611-627` — `wait failed` path may leak stdoutP/stderrP draining promises (bounded but dangling).

### Sandbox
- `sandbox-runner.ts:162-163` — when cwd is INSIDE a hidden dir (`~/.ssh/audit/`), `--bind cwd cwd` precedes `--tmpfs ~/.ssh`; the tmpfs masks the bound cwd. Inner process gets a working dir that vanishes. No precondition check.
- `sandbox-runner.ts:148-149` — `home-rw` exposes `~/.local/share/forja/sessions.db` (audit DB) writable. LLM can `sqlite3 ~/.local/share/forja/sessions.db "UPDATE approvals_log..."` and corrupt the hash chain in-place. `~/.bash_history`, `~/.zsh_history` similarly writable.
- `sandbox-runner-macos.ts:64-69` — `escapeSbplLiteral` doesn't reject `\n` / `\r`. SBPL profile is `\n`-joined; a path containing a newline breaks line structure and could land attacker-controlled tokens at the start of a fresh line.
- `engine.ts:1259` — `withSandboxProfile` does `decision.sandboxProfile = profile as SandboxProfile` (internal cast, the exact pattern slice 103 hardened against externally).

### CLI
- `doctor.ts:553` — `sealingCheck` constructs the SealStore but never calls `store.close()`. Today's worm-file impl has a no-op close; future s3/rfc3161/git backends would leak.
- `doctor-cache.ts:88` — Shared singleton cache survives across SessionStart boundaries within a long-running process. §13.8 line 939 lists SessionStart as a mandatory trigger; `resetSharedDoctorCache` exists but no caller wires it to SessionStart.
- `args.ts:1188-1201` — `agent --i-know-what-im-doing welcome` (flag BEFORE verb) is rejected. POSIX muscle memory (flags can precede positionals) loses.
- `doctor.ts:193` — `dirWritable` uses `accessSync(W_OK)` which is advisory on Windows. Slice 123 didn't gate on platform.

### Subagent + Telemetry + Sealing
- `hierarchy.ts:330-338` — Seal lock deep-equal uses raw `JSON.stringify`. Programmatic caller building `{ path, mode, locked }` (instead of `{ mode, path, locked }`) under a project-layer seal lock would spuriously flag `lockConflict`. YAML-loaded callers safe (parsePolicy canonicalizes); embedders not.
- `task.ts:98`, `task-async.ts:75` — `inputSchema.required` is advertisement-only. No JSON-schema validator runs ahead of execute; the §10 guard inside the tool body is the actual gate. Post-slice-94 comment overstates.
- `storage/repos/subagent-runs.ts:333-356` — Corrupt `effective_capabilities` collapses to NULL (root semantics) per the inline comment's choice. Trade-off vs deny-all is documented; worth re-litigating if R11 reviewers prefer fail-closed.
- `telemetry/scrubbing.ts:122-123` — `URL_REGEX` misses IPv6 (`[::1]:8080`), domain-only hosts without scheme (`internal.corp:443`), GitHub SSH (`git@github.com:org/repo.git`). SSH-form not covered by any pattern.

## P2 / nice-to-have polish

- Bash: cmdRsync `extractHost` dead `cut` variable; redirectShape rejects `concatenation` targets (asymmetric vs command args); bash/sh/zsh as command name produces generic "unknown_command" instead of cmdInterpreter's `-c` refuse path; ssh emits `netIngress('*')` for any port-forward — could be tighter as `netIngress('8080')`.
- Broker: `new AbortController().signal` returned when sources empty leaks a never-firing controller (wasted allocation); test gap on caller pre-aborted + master abort interaction; test gap on `scrubProtoPollution` recursive array path.
- Sandbox: test ordering invariant only pinned for home-rw, not ro/cwd-rw/cwd-rw-net (Linux); macOS test pins SBPL ordering across every profile (asymmetric coverage).
- CLI: `DoctorCheck` has no `readonly` markers and is stored by reference in cache (mutability hazard); `meta.createdAt` from welcome marker written raw to stdout without ANSI escape stripping.
- Subagent-async tool duplicates capability validation from sync task tool (acknowledged in code comment).

## Test coverage gaps

- No tests for: tar GTFOBins flags, rsync `-e`, glob/brace bypass, `mv -t`, `ssh -w 0:1`, `ssh -o LocalCommand`, `cargo clean` / `cargo new`, redirect with `concatenation` target, `chmod u+x` symbolic mode, `scp -P 22 host:f .`.
- No test asserting `chainCheck` doesn't leak DB handles.
- No test for cross-SessionStart cache behavior (R2.4 finding 4).
- No test for `agent --i-know-what-im-doing welcome` (flag-before-verb).

## Triage recommendations

The P0 cluster splits into three distinct work-streams:

1. **Resolver hardening** (P0-1, P0-2, P0-3) — bash resolver flag-value GTFOBins + glob/brace bypass. Each is a 1-2 slice fix with clear precedent (the ssh ProxyCommand refuse from slice 120).
2. **Sandbox boundary** (P0-4, P0-5, P0-6) — symlink escape, hide_paths drift, macOS TMPDIR exposure. P0-5 is a 1-slice fix (extend the list + add a fence test against `sensitive-paths.ts`); P0-4 and P0-6 are architectural (need either bwrap option / SBPL refinement / a docs-only "known limitation" call).
3. **Audit + telemetry surface for child engines** (P0-9, P0-10) — these together with the chainCheck DB issues (P0-7, P0-8) form a "doctor doesn't sanity-check enough; child sessions don't emit enough" theme. Each ~1 slice.

The drift between `sandbox-hide-paths.ts` and `sensitive-paths.ts` (R2.3 P0-2) suggests a structural fix worth more than just unifying the lists — both should derive from a single source-of-truth Set with a compile-time fence test asserting equality.

---

Generated by 5 parallel review agents, 2026-05-12. Slices reviewed: 95-124.
