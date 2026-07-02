// Mesh wire encode/parse. Reuses the shared NDJSON line encoder; the parser is
// mesh-specific (validates against the mesh message union, not the IPC one),
// modeled on src/subagents/ipc.ts parseLine — defensive, never throws, strips
// prototype-pollution keys via safeJsonParse. See docs/spec/MESH.md §4.

import { safeJsonParse } from '../broker/safe-json.ts';
import { encodeJsonLine } from '../wire/ndjson.ts';
import {
  MESH_PROTOCOL_VERSION,
  type MeshMessage,
  type MeshMessageType,
  type MeshProgressState,
} from './types.ts';

const KNOWN_TYPES: ReadonlySet<MeshMessageType> = new Set([
  'hello',
  'prompt',
  'progress',
  'result',
  'error',
  'bye',
]);

const PROGRESS_STATES: ReadonlySet<MeshProgressState> = new Set([
  'accepted',
  'working',
  'waiting-operator',
  'done',
]);

export const encodeMeshMessage = (msg: MeshMessage): string => encodeJsonLine(msg);

export type MeshParseResult = { ok: true; msg: MeshMessage } | { ok: false; reason: string };

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// Defensive — never throws; a malformed line surfaces as { ok:false } and the
// channel stays open (lineage from IPC §4.5).
export const parseMeshLine = (line: string): MeshParseResult => {
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (stripped.length === 0) return { ok: false, reason: 'empty_line' };

  let parsed: unknown;
  try {
    parsed = safeJsonParse(stripped);
  } catch {
    return { ok: false, reason: 'json_parse_failed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_object' };
  }
  const obj = parsed as Record<string, unknown>;

  const t = obj.type;
  if (typeof t !== 'string') return { ok: false, reason: 'missing_type' };
  if (!KNOWN_TYPES.has(t as MeshMessageType)) return { ok: false, reason: `unknown_type:${t}` };
  if (!isNonEmptyString(obj.id)) return { ok: false, reason: 'missing_id' };
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) {
    return { ok: false, reason: 'missing_ts' };
  }

  switch (t as MeshMessageType) {
    case 'hello':
      if (!isNonEmptyString(obj.alias)) return { ok: false, reason: 'hello.missing_alias' };
      if (typeof obj.protocolVersion !== 'number' || !Number.isFinite(obj.protocolVersion)) {
        return { ok: false, reason: 'hello.missing_protocolVersion' };
      }
      break;
    case 'prompt':
      if (!isNonEmptyString(obj.conversationId)) {
        return { ok: false, reason: 'prompt.missing_conversationId' };
      }
      if (typeof obj.text !== 'string') return { ok: false, reason: 'prompt.missing_text' };
      break;
    case 'progress':
      if (!isNonEmptyString(obj.conversationId)) {
        return { ok: false, reason: 'progress.missing_conversationId' };
      }
      if (!PROGRESS_STATES.has(obj.state as MeshProgressState)) {
        return { ok: false, reason: `progress.unknown_state:${String(obj.state)}` };
      }
      // Optional field: type-check when present so it can't slip a non-string
      // through the union contract.
      if (obj.note !== undefined && typeof obj.note !== 'string') {
        return { ok: false, reason: 'progress.note_not_string' };
      }
      break;
    case 'result':
      if (!isNonEmptyString(obj.conversationId)) {
        return { ok: false, reason: 'result.missing_conversationId' };
      }
      if (typeof obj.text !== 'string') return { ok: false, reason: 'result.missing_text' };
      break;
    case 'error':
      if (!isNonEmptyString(obj.code)) return { ok: false, reason: 'error.missing_code' };
      if (typeof obj.message !== 'string') return { ok: false, reason: 'error.missing_message' };
      if (obj.conversationId !== undefined && typeof obj.conversationId !== 'string') {
        return { ok: false, reason: 'error.conversationId_not_string' };
      }
      break;
    case 'bye':
      break;
  }
  return { ok: true, msg: obj as unknown as MeshMessage };
};

const stamp = (): { id: string; ts: number } => ({ id: crypto.randomUUID(), ts: Date.now() });

export const makeHello = (alias: string): MeshMessage => ({
  type: 'hello',
  alias,
  protocolVersion: MESH_PROTOCOL_VERSION,
  ...stamp(),
});
export const makePrompt = (conversationId: string, text: string): MeshMessage => ({
  type: 'prompt',
  conversationId,
  text,
  ...stamp(),
});
export const makeProgress = (
  conversationId: string,
  state: MeshProgressState,
  note?: string,
): MeshMessage => ({
  type: 'progress',
  conversationId,
  state,
  ...(note !== undefined ? { note } : {}),
  ...stamp(),
});
export const makeResult = (conversationId: string, text: string): MeshMessage => ({
  type: 'result',
  conversationId,
  text,
  ...stamp(),
});
export const makeError = (code: string, message: string, conversationId?: string): MeshMessage => ({
  type: 'error',
  code,
  message,
  ...(conversationId !== undefined ? { conversationId } : {}),
  ...stamp(),
});
export const makeBye = (): MeshMessage => ({ type: 'bye', ...stamp() });
