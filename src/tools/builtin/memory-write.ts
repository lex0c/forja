import {
  FrontmatterError,
  type MemoryFrontmatter,
  type MemoryScope,
  type MemorySource,
  type MemoryType,
  type WriteMemoryResult,
  validateFrontmatter,
} from '../../memory/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// memory_write — propose a new memory file (MEMORY.md §5.1, §8).
//
// Pipeline (every gate independent so audit shows where the
// proposal died):
//
//   1. Plumbing checks: aborted? registry available?
//   2. Schema/shape: name/description/type/source/body required;
//      validateFrontmatter mirrors disk-side validation so the
//      tool rejects same way the writer would on the same input.
//   3. project_shared rejected — promotion is a separate explicit
//      act per §5.1.3 / §5.4. The writer ALSO rejects this; the
//      tool repeats the gate up front so audit gets a clean
//      `refused` row before the operator is asked to confirm.
//   4. Injection / secret scanner (§7.3) — block + audit refused
//      with reason. Spec lists "ignore previous instructions",
//      "you are now", "from now on, always", and common secret
//      patterns. Match on the body (frontmatter shape is already
//      validated; only the body has injection-vector content).
//   5. Headless rejection — when the harness wasn't wired with a
//      modal callback, persist refused per §5.1.6. CI / one-shot
//      runs land here.
//   6. Modal confirm — operator decides. yes → persist, no →
//      explicit refusal (audit), cancel → Esc/timeout (audit).
//   7. Persist via MemoryRegistry.write — emits `created` on
//      success (or `refused` when the writer's own gates fire,
//      e.g. exists collision or symlink defense).
//
// Source semantics: the schema accepts `user_explicit` and
// `inferred` but NOT `imported` — `imported` is reserved for the
// promotion / demotion flow (§5.4 / §5.5) where the source comes
// from another scope, not a fresh proposal. A model-supplied
// `imported` is a programmer / prompt mistake; reject early.
//
// Expiry default (§6.2): project-scope memories with source
// `inferred` and no explicit `expires` get `+90d` from "now"
// applied at the tool layer (NOT the writer), so callers that
// bypass the tool keep control over their own defaults.

const VALID_SCOPES: ReadonlySet<string> = new Set(['user', 'project_shared', 'project_local']);
const VALID_TYPES: ReadonlySet<string> = new Set(['user', 'feedback', 'project', 'reference']);
const VALID_SOURCES_FOR_TOOL: ReadonlySet<string> = new Set(['user_explicit', 'inferred']);

export interface MemoryWriteInput {
  name: string;
  scope: 'user' | 'project_local' | 'project_shared';
  type: MemoryType;
  source: 'user_explicit' | 'inferred';
  description: string;
  body: string;
  expires?: string;
}

export interface MemoryWriteOutput {
  // 'created' on success; 'rejected' when the operator declined
  // or any gate fired. Tools usually map a non-success outcome to
  // `is_error: true`, but here both outcomes are valid model
  // input — the model proposed something and got an answer.
  outcome: 'created' | 'rejected';
  scope: MemoryScope;
  name: string;
  // On 'created', the absolute path of the body file. Absent on
  // 'rejected'.
  path?: string;
  // Stable reason string the model can echo back to the operator.
  reason: string;
}

// Regex-style patterns for the injection / secret scanner. Match
// the substring case-insensitively against the body. These are
// HEURISTIC defenses, not airtight — a determined attacker can
// rephrase. The bar is "raise the cost of the obvious vector"
// (AGENTS.md drop-in injection per §7.1), not "stop a human red
// team". Keep the list short so false positives stay rare.
//
// Spec §7.3:
//   - "ignore previous instructions"
//   - "you are now"
//   - "from now on, always"
//   - secret patterns (AWS keys, GitHub tokens, etc.)
const INJECTION_PHRASES: readonly string[] = [
  'ignore previous instructions',
  'ignore all previous',
  'you are now',
  'from now on, always',
  'disregard prior',
  'forget previous',
];

// Secret-pattern regexes. Anchored on common high-entropy prefixes
// so a memory body that mentions "AKIA" in prose without the full
// key doesn't trigger. Patterns:
//   - AWS access key id: `AKIA` + 16 [A-Z0-9]
//   - GitHub PAT (classic): `ghp_` + 36 chars
//   - GitHub fine-grained: `github_pat_` + ...
//   - Anthropic key: `sk-ant-` + ...
//   - OpenAI key: `sk-` + 40+ alnum (kept loose; these key formats churn)
//   - Slack token: `xox[baprs]-...`
const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{40,}\b/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

interface ScanResult {
  ok: boolean;
  // The first matched phrase / pattern label, used in the audit
  // row's `details.reason`. We don't enumerate every match — one
  // is enough to refuse, and surfacing more would reveal which
  // patterns we ship to an attacker.
  reason?: string;
}

const scanForInjection = (body: string): ScanResult => {
  const lower = body.toLowerCase();
  for (const phrase of INJECTION_PHRASES) {
    if (lower.includes(phrase)) {
      return { ok: false, reason: `injection phrase: ${JSON.stringify(phrase)}` };
    }
  }
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(body)) {
      return { ok: false, reason: 'secret pattern matched' };
    }
  }
  return { ok: true };
};

const isoDateForOffset = (offsetDays: number, now: Date = new Date()): string => {
  const ms = now.getTime() + offsetDays * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

export const memoryWriteTool: Tool<MemoryWriteInput, MemoryWriteOutput> = {
  name: 'memory_write',
  description:
    'Propose a new memory entry. Always opens an operator-confirmation modal — only persists on explicit accept. Reject scopes: project_shared (use /memory promote), name collisions in same scope (no overwrite), bodies matching injection / secret heuristics. Source must be user_explicit (operator asked to save) or inferred (you decided). For inferred + project scope, expires defaults to +90 days when omitted. In headless mode the call is rejected per spec §5.1.6.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Canonical kebab-case identifier, unique within scope. Filesystem-portable: [a-z0-9][a-z0-9_-]* up to 120 chars.',
      },
      scope: {
        type: 'string',
        enum: ['user', 'project_local'],
        description:
          'user = global per-machine; project_local = per-user within this repo (gitignored). project_shared cannot be written directly — use /memory promote for that path.',
      },
      type: {
        type: 'string',
        enum: ['user', 'feedback', 'project', 'reference'],
        description:
          'Spec category. user = profile / role; feedback = corrections + validated approaches; project = ongoing work context; reference = pointers to external systems.',
      },
      source: {
        type: 'string',
        enum: ['user_explicit', 'inferred'],
        description:
          'user_explicit = operator asked you to save this; inferred = you decided based on a correction / validation. Inferred memories require operator confirmation and may carry trust=untrusted markers.',
      },
      description: {
        type: 'string',
        description:
          'One-line hook shown in the per-scope MEMORY.md index. Single line, <=200 chars.',
      },
      body: {
        type: 'string',
        description:
          'Full markdown body of the memory file. For feedback/project entries, include "Why:" and "How to apply:" lines per the system prompt template. Will be scanned for injection patterns before reaching the operator confirm modal.',
      },
      expires: {
        type: 'string',
        description:
          'Optional ISO date YYYY-MM-DD. When omitted for inferred memories in project scope, defaults to +90 days. user_explicit memories never auto-expire.',
      },
    },
    required: ['name', 'scope', 'type', 'source', 'description', 'body'],
  },
  metadata: {
    category: 'misc',
    // Persists to disk. Plan mode blocks writes by default
    // (writes:true + omitted planSafe), which is correct — the
    // model shouldn't be saving memories during a planning
    // phase.
    writes: true,
    // Body / index files live in `~/.config/agent/memory/` (user
    // scope) — outside the worktree. Even project_local writes
    // land in `.agent/memory/local/` which is gitignored, so
    // checkpoint snapshots don't capture memory state. Surface
    // the warning in `--undo` per CHECKPOINTS.md §2.6.
    escapesCwd: true,
    // Awaits the modal-bridge `confirmMemoryWrite` callback before
    // persisting. Subagent contexts don't have one (no IPC modal
    // pipe), so this tool can't run in a subagent — the subagent
    // validator (`src/subagents/validate.ts`) rejects whitelists
    // that include it.
    requiresOperatorConfirm: true,
    idempotent: false,
    display: 'raw',
    cost: { latency_ms_typical: 50 },
  },
  async execute(args, ctx): Promise<ToolResult<MemoryWriteOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before write', { retryable: true });
    }
    const registry = ctx.memoryRegistry;
    if (registry === undefined) {
      return toolError(
        'memory.registry_unavailable',
        'memory_write requires a memory registry but none was provided',
        {
          hint: 'The harness was constructed without a memoryRegistry. Check HarnessConfig.',
        },
      );
    }

    // Schema-shape validation. We re-run validateFrontmatter so
    // the tool surface rejects identically to the disk path; a
    // future change in either side stays consistent because both
    // funnel through the same validator.
    const errs = validateInputs(args);
    if (errs !== null) return errs;

    const scope = args.scope as MemoryScope;
    const source = args.source as MemorySource;

    // 4a. Direct gate: project_shared rejected at tool layer (the
    // writer also rejects, but stopping early avoids opening a
    // modal that's guaranteed to fail).
    if (scope === 'project_shared') {
      registry.recordEvent({
        action: 'refused',
        scope,
        memoryName: args.name,
        source,
        details: { stage: 'tool_gate', reason: 'shared_forbidden' },
        auditSessionId: ctx.sessionId,
        auditCwd: ctx.cwd,
      });
      return toolError(
        'memory.shared_forbidden',
        'direct writes to project_shared are forbidden; use /memory promote shared <name>',
        {
          hint: 'Promotion runs an additional scanner + operator confirm; it is the only path into shared scope.',
        },
      );
    }

    // 4b'. Trust gate (MEMORY.md §7.2.1): inferred writes refused
    // when cwd is untrusted. The fired-at-boot trust modal usually
    // makes this unreachable in REPL flows (cwd gets persisted
    // BEFORE bootstrap runs), but one-shot mode (`agent "prompt"`)
    // bypasses the modal — without this gate, a model running in
    // a freshly-cloned untrusted repo could persist `inferred`
    // memories that future sessions auto-load. user_explicit
    // writes proceed regardless: the operator typed the proposal
    // themselves, so the trust risk is moot. Audited as
    // `refused` stage='trust_gate' so an operator inspecting
    // /memory audit can spot the pattern.
    if (!ctx.isCwdTrusted && source === 'inferred') {
      registry.recordEvent({
        action: 'refused',
        scope,
        memoryName: args.name,
        source,
        details: { stage: 'trust_gate', reason: 'cwd_untrusted' },
        auditSessionId: ctx.sessionId,
        auditCwd: ctx.cwd,
      });
      return toolError(
        'memory.untrusted_cwd',
        `cwd is not trusted; refusing to persist inferred memory ${JSON.stringify(args.name)}`,
        {
          hint: 'Trust the directory at boot, or have the operator phrase the save as user_explicit.',
        },
      );
    }

    // 4b. Injection / secret scanner. Spec §7.3 names the body as
    // the scanned surface, but the description ALSO lands in
    // MEMORY.md and is read eager into the next session's system
    // prompt — so a description with prompt-injection content is
    // strictly more dangerous than the same content in the body
    // (which is lazy-loaded). Scanning both closes that gap;
    // matched-field surfaces in the audit row so operator can
    // tell where the offending content lived.
    for (const [field, text] of [
      ['body', args.body] as const,
      ['description', args.description] as const,
    ]) {
      const scan = scanForInjection(text);
      if (scan.ok) continue;
      registry.recordEvent({
        action: 'refused',
        scope,
        memoryName: args.name,
        source,
        details: { stage: 'scanner', field, reason: scan.reason ?? 'unknown' },
        auditSessionId: ctx.sessionId,
        auditCwd: ctx.cwd,
      });
      return toolError(
        'memory.scanner_blocked',
        `${field} matches an injection / secret heuristic; refusing to propose memory ${JSON.stringify(args.name)}`,
        {
          // Don't echo the matched pattern to the model — that
          // would teach future prompts how to bypass the scanner.
          // The operator-side audit row carries the detail.
          hint: 'Rephrase the field without prompt-injection language; do not include credentials.',
        },
      );
    }

    // 5. Headless rejection (spec §5.1.6).
    const confirm = ctx.confirmMemoryWrite;
    if (confirm === undefined) {
      registry.recordEvent({
        action: 'refused',
        scope,
        memoryName: args.name,
        source,
        details: { stage: 'headless_gate' },
        auditSessionId: ctx.sessionId,
        auditCwd: ctx.cwd,
      });
      return toolError(
        'memory.headless_mode',
        'memory_write rejected: headless mode (no confirmation surface attached)',
        {
          hint: 'Run inside an interactive REPL, or use /memory save once that slash command lands.',
        },
      );
    }

    // 6. Modal confirm. Emit `proposed` first so the audit row
    // exists even if the modal is closed without an answer (the
    // confirm path resolves with 'cancel' on Esc/timeout, but
    // recording the proposal up-front gives audit a chronological
    // anchor).
    registry.recordEvent({
      action: 'proposed',
      scope,
      memoryName: args.name,
      source,
      details: {
        type: args.type,
        description: args.description,
        ...(args.expires !== undefined ? { expires: args.expires } : {}),
      },
      auditSessionId: ctx.sessionId,
      auditCwd: ctx.cwd,
    });

    const answer = await confirm({
      scope,
      name: args.name,
      body: args.body,
    });

    if (answer !== 'yes') {
      registry.recordEvent({
        action: 'refused',
        scope,
        memoryName: args.name,
        source,
        details: { stage: 'modal', reason: answer === 'no' ? 'declined' : 'cancelled' },
        auditSessionId: ctx.sessionId,
        auditCwd: ctx.cwd,
      });
      return {
        outcome: 'rejected',
        scope,
        name: args.name,
        reason: answer === 'no' ? 'operator declined' : 'operator cancelled (esc/timeout)',
      };
    }

    // 6b. User-scope second confirm (MEMORY.md §7.2.5). User-
    // global memories load in EVERY session on the machine — the
    // first prompt asked about the WRITE; this one asks about
    // the SCOPE. Distinct modal text ("vai afetar todas as
    // sessões") forces the operator to re-engage rather than
    // habit-press 1.
    //
    // Headless variant: if `confirmMemoryWrite` was wired but
    // `confirmMemoryUserScope` is missing (programmer error or
    // partial test wiring), refuse fail-closed. We don't reach
    // this branch in production paths because REPL wires both
    // together; the gate exists so a future entrypoint that
    // forgets one of the two doesn't silently downgrade
    // user-scope security.
    if (scope === 'user') {
      const confirmScope = ctx.confirmMemoryUserScope;
      if (confirmScope === undefined) {
        registry.recordEvent({
          action: 'refused',
          scope,
          memoryName: args.name,
          source,
          details: { stage: 'headless_gate_user_scope' },
          auditSessionId: ctx.sessionId,
          auditCwd: ctx.cwd,
        });
        return toolError(
          'memory.headless_mode',
          'memory_write rejected: user-scope writes require a second confirmation surface that is not attached',
          {
            hint: 'Run inside an interactive REPL or write to project_local instead.',
          },
        );
      }
      const scopeAnswer = await confirmScope({
        name: args.name,
        body: args.body,
      });
      if (scopeAnswer !== 'yes') {
        registry.recordEvent({
          action: 'refused',
          scope,
          memoryName: args.name,
          source,
          details: {
            stage: 'user_scope_modal',
            reason: scopeAnswer === 'no' ? 'declined' : 'cancelled',
          },
          auditSessionId: ctx.sessionId,
          auditCwd: ctx.cwd,
        });
        return {
          outcome: 'rejected',
          scope,
          name: args.name,
          reason:
            scopeAnswer === 'no'
              ? 'operator declined user-scope persistence'
              : 'operator cancelled user-scope confirm (esc/timeout)',
        };
      }
    }

    // 7. Persist. Apply the +90d default for inferred + project
    // scope when no explicit expires was supplied (spec §6.2).
    const frontmatter = buildFrontmatter(args, scope, source);
    const result = registry.write({
      scope,
      frontmatter,
      body: args.body,
      auditSessionId: ctx.sessionId,
      auditCwd: ctx.cwd,
    });

    if (result.kind === 'created') {
      return {
        outcome: 'created',
        scope,
        name: args.name,
        path: result.path,
        reason: 'created',
      };
    }
    // Writer rejected — surface as a tool error mapped from the
    // discriminated kind. The registry already emitted the
    // `refused` audit row.
    return mapWriteFailure(result, scope, args.name);
  },
};

// Build the on-disk frontmatter from validated inputs. Applies
// the +90d default per spec §6.2; `user_explicit` never auto-
// expires (operator opted in, so the lifecycle gc shouldn't
// pre-empt them silently).
const buildFrontmatter = (
  args: MemoryWriteInput,
  scope: MemoryScope,
  source: MemorySource,
): MemoryFrontmatter => {
  const fm: MemoryFrontmatter = {
    name: args.name,
    description: args.description,
    type: args.type,
    source,
  };
  let expires = args.expires;
  if (
    expires === undefined &&
    source === 'inferred' &&
    (scope === 'project_local' || scope === 'project_shared')
  ) {
    expires = isoDateForOffset(90);
  }
  if (expires !== undefined) fm.expires = expires;
  return fm;
};

const validateInputs = (args: MemoryWriteInput): ToolResult<MemoryWriteOutput> | null => {
  if (typeof args.name !== 'string' || args.name.length === 0) {
    return toolError(ERROR_CODES.invalidArg, 'name must be a non-empty string');
  }
  if (typeof args.scope !== 'string' || !VALID_SCOPES.has(args.scope)) {
    return toolError(
      ERROR_CODES.invalidArg,
      `scope must be one of: user, project_local (got ${JSON.stringify(args.scope)})`,
    );
  }
  if (typeof args.type !== 'string' || !VALID_TYPES.has(args.type)) {
    return toolError(
      ERROR_CODES.invalidArg,
      `type must be one of: user, feedback, project, reference (got ${JSON.stringify(args.type)})`,
    );
  }
  if (typeof args.source !== 'string' || !VALID_SOURCES_FOR_TOOL.has(args.source)) {
    return toolError(
      ERROR_CODES.invalidArg,
      `source must be one of: user_explicit, inferred (got ${JSON.stringify(args.source)})`,
    );
  }
  if (typeof args.description !== 'string' || args.description.length === 0) {
    return toolError(ERROR_CODES.invalidArg, 'description must be a non-empty string');
  }
  if (typeof args.body !== 'string' || args.body.length === 0) {
    return toolError(ERROR_CODES.invalidArg, 'body must be a non-empty string');
  }
  if (args.expires !== undefined && typeof args.expires !== 'string') {
    return toolError(ERROR_CODES.invalidArg, 'expires must be a string when provided');
  }
  // Re-validate via the storage-layer validator. Catches name
  // shape, description length, expires shape, etc. — the same
  // rules the writer would enforce, surfaced as invalid_arg
  // instead of a thrown FrontmatterError.
  try {
    validateFrontmatter({
      name: args.name,
      description: args.description,
      type: args.type,
      source: args.source,
      ...(args.expires !== undefined ? { expires: args.expires } : {}),
    });
  } catch (err) {
    if (err instanceof FrontmatterError) {
      return toolError(ERROR_CODES.invalidArg, err.message);
    }
    throw err;
  }
  return null;
};

const mapWriteFailure = (
  result: WriteMemoryResult,
  scope: MemoryScope,
  name: string,
): ToolResult<MemoryWriteOutput> => {
  switch (result.kind) {
    case 'created':
      // Unreachable — caller checked `kind === 'created'` first.
      return { outcome: 'created', scope, name, path: result.path, reason: 'created' };
    case 'exists':
      return toolError(
        'memory.exists',
        `memory ${JSON.stringify(name)} already exists in scope ${scope}; refusing to overwrite`,
        {
          hint: 'Pick a different name, or use /memory edit (when available) to update the existing entry.',
        },
      );
    case 'shared_forbidden':
      return toolError(
        'memory.shared_forbidden',
        'direct writes to project_shared are forbidden; use /memory promote',
      );
    case 'sandbox_violation':
      return toolError('memory.sandbox_violation', result.reason);
    case 'symlink_refused':
      return toolError(
        'memory.symlink_refused',
        `target path is a symlink (${result.path}); refusing to follow`,
        {
          hint: 'Investigate the symlink before retrying — it may be an injection vector.',
        },
      );
    case 'index_full':
      return toolError(
        'memory.index_full',
        `MEMORY.md hard cap reached (${result.current}/${result.cap}); evict before writing`,
        {
          hint: 'Spec §3.2 caps the index at 200 lines. Delete or merge older entries first.',
        },
      );
    case 'io_error':
      return toolError('memory.io_error', `disk write failed: ${result.reason}`);
  }
};
