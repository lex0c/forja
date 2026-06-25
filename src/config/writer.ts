// Canonical writer for the per-project `.forja/config.toml`. Bun ships
// only `TOML.parse` (no stringify), so every config-mutation path
// (`/memory governance`, `/model` + `--model` model-pin autosave)
// round-trips the file as parse → mutate → emit-canonical HERE, in one
// place, instead of forking the emitter across slash commands and the
// bootstrap path.
//
// Round-trip caveats (shared by all callers):
//   - Comments and original whitespace are NOT preserved — the file is
//     re-emitted in a normalized shape. This is WHY the `forja init`
//     scaffold writes no inline comments (AGENTIC_CLI.md §2.1.1): a
//     scaffold comment would be wiped on the first mutation.
//   - Tables may nest (`[audit.retention]`, future `[sampling.thinking]`,
//     …). `emitTomlDoc` recurses, so a mutation no longer drops an
//     operator's nested sub-table. The flat-only predecessor (lived in
//     `memory.ts`) silently nuked `[audit.retention]` on every
//     `/memory governance` rewrite — a latent data-loss bug this
//     centralization fixes for both callers.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TOML_BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const emitTomlScalar = (v: unknown): string => {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return v.toString();
  if (typeof v === 'string') {
    return `"${v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')}"`;
  }
  if (Array.isArray(v)) return `[${v.map(emitTomlScalar).join(', ')}]`;
  // A non-null object reached the scalar path — only possible as an
  // element of an array value (an inline table / array-of-tables). Our
  // flat-schema emitter can't represent it; THROW rather than silently
  // emit `""` and destroy the data. `writeTomlDocAtomic` catches this and
  // returns `failed`, so a mutation keeps prior state + warns instead of
  // clobbering a `[[…]]` block the operator hand-added.
  if (v !== null && typeof v === 'object') {
    throw new Error(
      'cannot serialize an inline table / array-of-tables value (unsupported in .forja/config.toml)',
    );
  }
  return '""';
};

const emitTomlKey = (k: string): string => {
  if (TOML_BARE_KEY_RE.test(k)) return k;
  return `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const isScalarValue = (v: unknown): boolean =>
  v === null || typeof v !== 'object' || Array.isArray(v);

// Recursive table emitter. `path` is the dotted-header prefix (`[]` is
// the document root). Emits this table's scalar keys under its header,
// then recurses into each sub-table — obeying TOML's rule that a table's
// own scalar keys must precede any child-table header.
const emitTable = (path: string[], table: Record<string, unknown>, out: string[]): void => {
  const scalarLines: string[] = [];
  const subTables: Array<[string, Record<string, unknown>]> = [];
  for (const [k, v] of Object.entries(table)) {
    if (isScalarValue(v)) {
      scalarLines.push(`${emitTomlKey(k)} = ${emitTomlScalar(v)}`);
    } else {
      subTables.push([k, v as Record<string, unknown>]);
    }
  }
  if (path.length === 0) {
    // Root: bare scalar keys form a header-less block that MUST precede
    // every table header. The caller emits root first, so they do.
    if (scalarLines.length > 0) out.push(scalarLines.join('\n'));
  } else {
    const header = `[${path.map(emitTomlKey).join('.')}]`;
    if (scalarLines.length > 0) {
      out.push([header, ...scalarLines].join('\n'));
    } else if (subTables.length === 0) {
      // Declared-but-empty `[section]` — preserve the bare header so the
      // round-trip doesn't silently drop it.
      out.push(header);
    }
    // else: no scalars but has children — the header is implied by the
    // child headers (`[a.b]`), so we skip emitting a redundant `[a]`.
  }
  for (const [k, sub] of subTables) emitTable([...path, k], sub, out);
};

// Serialize a plain doc to canonical TOML. Exported so `/memory
// governance` can share the exact same emitter (single source for the
// round-trip's quirks).
export const emitTomlDoc = (doc: Record<string, unknown>): string => {
  const out: string[] = [];
  emitTable([], doc, out);
  return out.length > 0 ? `${out.join('\n\n')}\n` : '';
};

// Read + parse a config.toml into a plain doc. Absent / empty file → an
// empty doc (a fresh mutation materializes the file). Malformed TOML is
// a hard failure — refuse to clobber a file we can't round-trip safely.
export const readTomlDoc = (
  filePath: string,
): { ok: true; doc: Record<string, unknown> } | { ok: false; reason: string } => {
  if (!existsSync(filePath)) return { ok: true, doc: {} };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not read ${filePath}: ${errMsg(err)}` };
  }
  if (raw.length === 0) return { ok: true, doc: {} };
  // Strip a leading UTF-8 BOM. `readFileSync('utf8')` decodes the BOM
  // bytes to U+FEFF but does NOT remove them, and `Bun.TOML.parse` treats
  // a BOM-prefixed document as empty (`{}`) rather than throwing — so
  // without this a mutation would read `doc = {}` on a real config and
  // clobber EVERY section on the next write (silent data loss on a file
  // a Windows editor saved with a BOM).
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    const parsed = Bun.TOML.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, doc: parsed as Record<string, unknown> };
    }
    return { ok: true, doc: {} };
  } catch {
    return {
      ok: false,
      reason: `existing ${filePath} has malformed TOML; edit manually or remove the file`,
    };
  }
};

// Emit `doc` to `filePath` via atomic temp+rename (mirror of
// src/memory/writer.ts — a partial write never leaves a truncated
// config behind). Creates the parent dir if absent.
export const writeTomlDocAtomic = (
  filePath: string,
  doc: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } => {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, emitTomlDoc(doc));
    renameSync(tmp, filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `could not write ${filePath}: ${errMsg(err)}` };
  }
};

export type PersistModelPinResult =
  // The pin changed and the file was (re)written.
  | { kind: 'written' }
  // `[providers].model` already equals `modelId`; nothing written.
  | { kind: 'unchanged' }
  // Read / parse / write error. The caller keeps the in-memory model
  // and surfaces `reason` — persistence is best-effort, never fatal.
  | { kind: 'failed'; reason: string };

// Persist `[providers].model = modelId` into the project `config.toml`,
// preserving every other section/key verbatim through the round-trip.
//
// IDEMPOTENT by design: when the file already pins `modelId`, returns
// `unchanged` WITHOUT rewriting. This matters because the round-trip
// normalizes formatting and drops comments — a write-on-every-invocation
// would churn the (typically committed) config file for no semantic
// change. The autosave callers (`--model` at boot, `/model` in-session)
// rely on this so a repeated same-model selection is a true no-op.
export const persistModelPin = (params: {
  filePath: string;
  modelId: string;
}): PersistModelPinResult => {
  const { filePath, modelId } = params;
  const read = readTomlDoc(filePath);
  if (!read.ok) return { kind: 'failed', reason: read.reason };
  const doc = read.doc;

  // Refuse if `[providers]` exists but isn't a table — overwriting it
  // with `{ model }` would silently drop whatever was there (e.g. an
  // array-of-tables `[[providers]]`, or a scalar). Honors the
  // preserve-verbatim contract by bailing rather than clobbering.
  if (
    doc.providers !== undefined &&
    (doc.providers === null || typeof doc.providers !== 'object' || Array.isArray(doc.providers))
  ) {
    return {
      kind: 'failed',
      reason: `[providers] in ${filePath} is not a table; refusing to overwrite`,
    };
  }
  const providers = (doc.providers as Record<string, unknown> | undefined) ?? {};
  if (providers.model === modelId) return { kind: 'unchanged' };

  providers.model = modelId;
  doc.providers = providers;

  const write = writeTomlDocAtomic(filePath, doc);
  if (!write.ok) return { kind: 'failed', reason: write.reason };
  return { kind: 'written' };
};
