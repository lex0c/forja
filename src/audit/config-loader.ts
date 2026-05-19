// Operator-facing config loader for retention sweeps (AUDIT.md
// §1.2, consumed by AGENTIC_CLI §2.1.3 `agent gc`). Reads
// `[audit.retention]` from `config.toml` in two layers:
//   1. user:    `~/.config/agent/config.toml`
//   2. project: `<cwd>/.agent/config.toml`
//
// Project overrides user (per-key; later layer wins). No enterprise
// layer in Phase 1 — retention is operational hygiene, not
// security-sensitive (the values are TTLs, not access decisions).
// Add the third layer later if a regulated environment needs to
// pin retention floors.
//
// Phase 1 honors four keys (the tables Phase 1 sweeps); the rest
// of the AUDIT §1.2 schema is accepted silently for forward
// compatibility (Phase 2/3/4 will activate them) but produces no
// runtime effect. Unknown keys NOT in the schema get a warning so
// typos surface.

import { existsSync } from 'node:fs';
import { projectConfigPath, userConfigPath } from '../config/paths.ts';
import { loadTomlSection } from '../config/section.ts';

// Phase 1 retention defaults (matches AUDIT.md §1.2 verbatim). Days
// for the 3 cold tables; absolute ms for recap_cache (TTL-based).
//
// Why ms for recap_cache: the cache writer populates `expires_at`
// at INSERT with `now + TTL`, so retention isn't an "age cutoff"
// but a "row-level TTL window". Operators expressing it as "1h"
// in TOML get parsed into 3_600_000 ms here; that's the value the
// writer would multiply against (today the writer uses
// `DEFAULT_RECAP_CACHE_TTL_MS = 1h` internally — the spec key
// covers the override path for ops who want shorter / longer
// freshness windows).
//
// `runGcOnStop` is the Phase 5 built-in trigger: when true, the
// harness calls runGc({force: true, ...}) at session end (after
// the operator-declared Stop hooks fire). Default false — opt-in.
// Lives in `[audit]` (sibling of `[audit.retention]`), not nested,
// because it's an operational toggle rather than a TTL.
export const DEFAULT_RETENTION = {
  // Phase 1 (4 low-sensitivity tables):
  recap_cache_ttl_ms: 60 * 60 * 1000, // 1h
  retrieval_trace_days: 90,
  context_pins_days: 90,
  bg_processes_days: 30,
  // Phase 2 (6 audit-cascade tables — AUDIT §1.2 defaults):
  memory_events_days: 365,
  hook_runs_days: 90,
  failure_events_days: 365,
  eviction_events_days: 365,
  outcomes_days: 90,
  // outcome_signals uses per-row TTL (ttl_expires_at populated at
  // INSERT). The flag here just gates whether gc sweeps the expired
  // rows or leaves them alone. Default true (sweep enabled).
  outcomeSignalsEnabled: true,
  // Operational:
  runGcOnStop: false,
} as const;

export interface RetentionConfig {
  // Phase 1:
  recap_cache_ttl_ms: number;
  retrieval_trace_days: number;
  context_pins_days: number;
  bg_processes_days: number;
  // Phase 2:
  memory_events_days: number;
  hook_runs_days: number;
  failure_events_days: number;
  eviction_events_days: number;
  outcomes_days: number;
  outcomeSignalsEnabled: boolean;
  // Operational:
  runGcOnStop: boolean;
}

// AUDIT §1.2 schema keys. Phase 1 + Phase 2 (10 tables) are
// validated + applied; the rest are accepted silently (no runtime
// effect, forward compat for Phase 3/4). A typo like
// `retreival_trace = 90` lands as "unknown key" warning so the
// operator sees it.
const KNOWN_SCHEMA_KEYS = new Set([
  // Phase 1 (validated + applied):
  'recap_cache',
  'retrieval_trace',
  'context_pins',
  'bg_processes',
  // Phase 2 (validated + applied):
  'memory_events',
  'hook_runs',
  'failure_events',
  'eviction_events',
  'outcomes',
  'outcome_signals',
  // Phase 3+ (accepted, ignored at runtime — forward compat):
  'default_days',
  'sessions',
  'messages',
  'approvals',
  'approvals_log',
  'policies',
  'pending_decisions',
  'prompt_versions',
  'purge_events',
]);

const PHASE_1_KEYS = new Set(['recap_cache', 'retrieval_trace', 'context_pins', 'bg_processes']);

// Known keys directly under `[audit]` (siblings of `[audit.retention]`).
// Operator typos like `[audit].run_gc_on_stp = true` would otherwise
// be silently dropped. Mirrors the KNOWN_SCHEMA_KEYS typo guard for
// `[audit.retention].*` so both sections behave symmetrically.
const KNOWN_AUDIT_KEYS = new Set(['run_gc_on_stop', 'retention']);

type PartialLayer = Partial<RetentionConfig>;

interface ParseResult {
  layer: PartialLayer;
  warnings: string[];
}

// Format a value defensively for inclusion in a warning string.
const fmtBad = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

// Parse a TTL string ("1h", "30m", "5s", "500ms") OR a positive
// integer (treated as ms) into milliseconds. Returns null if the
// input is malformed. Strict: "1.5h" is rejected (only integer
// scalars accepted; spec example uses whole-number durations).
const parseTtlMs = (input: unknown): number | null => {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0 || !Number.isInteger(input)) return null;
    return input;
  }
  if (typeof input !== 'string') return null;
  const m = /^(\d+)(ms|s|m|h)$/.exec(input.trim());
  if (m === null) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    default:
      return null;
  }
};

// Parse a positive-integer "days" value. Rejects floats, zero,
// negatives. The "forever" sentinel is NOT a phase-1 concern (no
// phase-1 table accepts forever); will land in phase 2/3 alongside
// the policies / prompt_versions tables that need it.
const parseDays = (input: unknown): number | null => {
  if (typeof input !== 'number') return null;
  if (!Number.isFinite(input) || input <= 0 || !Number.isInteger(input)) return null;
  return input;
};

const parseLayer = (path: string | null, source: string): ParseResult => {
  const layer: PartialLayer = {};
  const warnings: string[] = [];
  const section = loadTomlSection(path, 'audit', source);
  if (section.kind === 'absent' || section.kind === 'no-section') return { layer, warnings };
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return { layer, warnings };
  }
  // `[audit]` IS the section we found. Parse the sibling
  // `run_gc_on_stop` flag (operational toggle, not a TTL — lives
  // alongside `[audit.retention]`, not inside it) BEFORE drilling
  // down. Boolean: rejects strings/numbers with a warning. Absent
  // → falls through to default.
  const auditTable = section.section;

  // Typo guard at the `[audit].*` level. Symmetric with the
  // `[audit.retention].*` guard below — operator who wrote
  // `[audit].run_gc_on_stp = true` (typo) gets a warning instead
  // of silent default. Without this, the asymmetry would surprise
  // an operator who learned to expect typo guards from the
  // retention section.
  for (const key of Object.keys(auditTable)) {
    if (!KNOWN_AUDIT_KEYS.has(key)) {
      warnings.push(
        `${source} config (${path}): [audit].${key} is not a known audit key; ignoring`,
      );
    }
  }

  if (auditTable.run_gc_on_stop !== undefined) {
    if (typeof auditTable.run_gc_on_stop !== 'boolean') {
      warnings.push(
        `${source} config (${path}): [audit].run_gc_on_stop=${fmtBad(auditTable.run_gc_on_stop)} must be a boolean (true|false); ignoring`,
      );
    } else {
      layer.runGcOnStop = auditTable.run_gc_on_stop;
    }
  }

  // The retention block is nested as `[audit.retention]` which TOML
  // serializes as `auditTable.retention` being a Record. Drill down.
  const retention = auditTable.retention;
  if (retention === undefined) return { layer, warnings };
  if (retention === null || typeof retention !== 'object' || Array.isArray(retention)) {
    warnings.push(
      `${source} config (${path}): [audit.retention] must be a table; got ${fmtBad(retention)}`,
    );
    return { layer, warnings };
  }
  const r = retention as Record<string, unknown>;

  // Surface typos / unknown keys so an operator who wrote
  // `retreival_trace = 90` sees the warning instead of silently
  // running with the default.
  for (const key of Object.keys(r)) {
    if (!KNOWN_SCHEMA_KEYS.has(key)) {
      warnings.push(
        `${source} config (${path}): [audit.retention].${key} is not a known retention key; ignoring`,
      );
    }
  }

  // Phase 1 validation. Each key validates independently — a bad
  // value falls back to the default with a warning, no crash.

  if (r.recap_cache !== undefined) {
    const ms = parseTtlMs(r.recap_cache);
    if (ms === null) {
      warnings.push(
        `${source} config (${path}): [audit.retention].recap_cache=${fmtBad(r.recap_cache)} must be a positive duration ("1h", "30m", "5s", "500ms") or positive integer ms; ignoring`,
      );
    } else {
      layer.recap_cache_ttl_ms = ms;
    }
  }
  if (r.retrieval_trace !== undefined) {
    const d = parseDays(r.retrieval_trace);
    if (d === null) {
      warnings.push(
        `${source} config (${path}): [audit.retention].retrieval_trace=${fmtBad(r.retrieval_trace)} must be a positive integer (days); ignoring`,
      );
    } else {
      layer.retrieval_trace_days = d;
    }
  }
  if (r.context_pins !== undefined) {
    const d = parseDays(r.context_pins);
    if (d === null) {
      warnings.push(
        `${source} config (${path}): [audit.retention].context_pins=${fmtBad(r.context_pins)} must be a positive integer (days); ignoring`,
      );
    } else {
      layer.context_pins_days = d;
    }
  }
  if (r.bg_processes !== undefined) {
    const d = parseDays(r.bg_processes);
    if (d === null) {
      warnings.push(
        `${source} config (${path}): [audit.retention].bg_processes=${fmtBad(r.bg_processes)} must be a positive integer (days); ignoring`,
      );
    } else {
      layer.bg_processes_days = d;
    }
  }

  // Phase 2 validation. Five day-based fields (memory_events,
  // hook_runs, failure_events, eviction_events, outcomes) follow the
  // same parseDays pattern as Phase 1. outcome_signals is special:
  // accepts boolean (true/false) OR string `"per-kind"` (alias for
  // true). Other strings → warning + fallback to default (enabled).

  if (r.memory_events !== undefined) {
    const d = parseDays(r.memory_events);
    if (d === null) {
      warnings.push(
        `${source} config (${path}): [audit.retention].memory_events=${fmtBad(r.memory_events)} must be a positive integer (days); ignoring`,
      );
    } else {
      layer.memory_events_days = d;
    }
  }
  if (r.hook_runs !== undefined) {
    const d = parseDays(r.hook_runs);
    if (d === null) {
      warnings.push(
        `${source} config (${path}): [audit.retention].hook_runs=${fmtBad(r.hook_runs)} must be a positive integer (days); ignoring`,
      );
    } else {
      layer.hook_runs_days = d;
    }
  }
  if (r.failure_events !== undefined) {
    const d = parseDays(r.failure_events);
    if (d === null) {
      warnings.push(
        `${source} config (${path}): [audit.retention].failure_events=${fmtBad(r.failure_events)} must be a positive integer (days); ignoring`,
      );
    } else {
      layer.failure_events_days = d;
    }
  }
  if (r.eviction_events !== undefined) {
    const d = parseDays(r.eviction_events);
    if (d === null) {
      warnings.push(
        `${source} config (${path}): [audit.retention].eviction_events=${fmtBad(r.eviction_events)} must be a positive integer (days); ignoring`,
      );
    } else {
      layer.eviction_events_days = d;
    }
  }
  if (r.outcomes !== undefined) {
    const d = parseDays(r.outcomes);
    if (d === null) {
      warnings.push(
        `${source} config (${path}): [audit.retention].outcomes=${fmtBad(r.outcomes)} must be a positive integer (days); ignoring`,
      );
    } else {
      layer.outcomes_days = d;
    }
  }
  if (r.outcome_signals !== undefined) {
    const v = r.outcome_signals;
    if (typeof v === 'boolean') {
      layer.outcomeSignalsEnabled = v;
    } else if (typeof v === 'string' && v === 'per-kind') {
      // Spec literal — alias for `true` (honor per-row TTL).
      layer.outcomeSignalsEnabled = true;
    } else {
      warnings.push(
        `${source} config (${path}): [audit.retention].outcome_signals=${fmtBad(v)} must be a boolean (true|false) or the literal "per-kind"; ignoring`,
      );
    }
  }

  return { layer, warnings };
};

export interface LoadRetentionInput {
  cwd: string;
  // Test seam: skip file I/O entirely and feed a pre-parsed
  // {user, project} layer set. When omitted, paths are resolved
  // via the production helpers below.
  userPath?: string | null;
  projectPath?: string | null;
}

export interface LoadedRetentionConfig {
  config: RetentionConfig;
  warnings: string[];
  // Source provenance so the CLI can render "config from
  // ~/.config/agent/config.toml (overriding defaults)" — helps
  // operators trace surprising deletes back to a misconfig.
  sources: {
    user: string | null;
    project: string | null;
  };
}

export const loadRetentionConfig = (input: LoadRetentionInput): LoadedRetentionConfig => {
  const userPath = input.userPath !== undefined ? input.userPath : userConfigPath();
  const projectPath =
    input.projectPath !== undefined ? input.projectPath : projectConfigPath(input.cwd);

  const userParse = parseLayer(userPath, 'user');
  const projectParse = parseLayer(projectPath, 'project');

  // Per-key merge: project > user > default. Each layer is partial;
  // any key absent falls through to the next.
  const config: RetentionConfig = {
    recap_cache_ttl_ms:
      projectParse.layer.recap_cache_ttl_ms ??
      userParse.layer.recap_cache_ttl_ms ??
      DEFAULT_RETENTION.recap_cache_ttl_ms,
    retrieval_trace_days:
      projectParse.layer.retrieval_trace_days ??
      userParse.layer.retrieval_trace_days ??
      DEFAULT_RETENTION.retrieval_trace_days,
    context_pins_days:
      projectParse.layer.context_pins_days ??
      userParse.layer.context_pins_days ??
      DEFAULT_RETENTION.context_pins_days,
    bg_processes_days:
      projectParse.layer.bg_processes_days ??
      userParse.layer.bg_processes_days ??
      DEFAULT_RETENTION.bg_processes_days,
    // Phase 2 day-based fields use `??` (number merge is safe;
    // no falsy trap):
    memory_events_days:
      projectParse.layer.memory_events_days ??
      userParse.layer.memory_events_days ??
      DEFAULT_RETENTION.memory_events_days,
    hook_runs_days:
      projectParse.layer.hook_runs_days ??
      userParse.layer.hook_runs_days ??
      DEFAULT_RETENTION.hook_runs_days,
    failure_events_days:
      projectParse.layer.failure_events_days ??
      userParse.layer.failure_events_days ??
      DEFAULT_RETENTION.failure_events_days,
    eviction_events_days:
      projectParse.layer.eviction_events_days ??
      userParse.layer.eviction_events_days ??
      DEFAULT_RETENTION.eviction_events_days,
    outcomes_days:
      projectParse.layer.outcomes_days ??
      userParse.layer.outcomes_days ??
      DEFAULT_RETENTION.outcomes_days,
    // Boolean merge needs `!== undefined` instead of `??` (same
    // false-respecting reason as runGcOnStop below):
    outcomeSignalsEnabled:
      projectParse.layer.outcomeSignalsEnabled !== undefined
        ? projectParse.layer.outcomeSignalsEnabled
        : userParse.layer.outcomeSignalsEnabled !== undefined
          ? userParse.layer.outcomeSignalsEnabled
          : DEFAULT_RETENTION.outcomeSignalsEnabled,
    // Boolean merge needs `!== undefined` instead of `??` because
    // `false ?? user_true` evaluates to `user_true` — the project's
    // explicit `false` would be silently dropped. Operator that
    // disables gc-on-Stop in a specific project (despite enabling
    // it user-wide) MUST win.
    runGcOnStop:
      projectParse.layer.runGcOnStop !== undefined
        ? projectParse.layer.runGcOnStop
        : userParse.layer.runGcOnStop !== undefined
          ? userParse.layer.runGcOnStop
          : DEFAULT_RETENTION.runGcOnStop,
  };

  // `sources` reflects file EXISTENCE, not just path resolution.
  // The resolver helpers (`userConfigPath` / `projectConfigPath`)
  // always return a string when XDG is set, regardless of whether
  // the file exists on disk. Reporting the resolved path as the
  // active source would mislead operators ("Config source: /foo/
  // .agent/config.toml") when in fact defaults were used because
  // the file doesn't exist. We resolve to null when the file is
  // absent so the renderer can correctly fall back to "defaults".
  const userExists = userPath !== null && existsSync(userPath);
  const projectExists = projectPath !== null && existsSync(projectPath);
  return {
    config,
    warnings: [...userParse.warnings, ...projectParse.warnings],
    sources: {
      user: userExists ? userPath : null,
      project: projectExists ? projectPath : null,
    },
  };
};

// Re-export for tests that want to pin the parser independently
// of the layer merge.
export { parseTtlMs, parseDays, PHASE_1_KEYS };
