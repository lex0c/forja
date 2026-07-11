// Mesh wire encode/parse. Reuses the shared NDJSON line encoder; the parser is
// mesh-specific (validates against the mesh message union, not the IPC one),
// modeled on src/subagents/ipc.ts parseLine — defensive, never throws, strips
// prototype-pollution keys via safeJsonParse. See docs/spec/MESH.md §4.

import { safeJsonParse } from '../broker/safe-json.ts';
import { encodeJsonLine } from '../wire/ndjson.ts';
import { MESH_PROTOCOL_VERSION, type MeshMessage, type MeshMessageType } from './types.ts';

const KNOWN_TYPES: ReadonlySet<MeshMessageType> = new Set(['hello', 'message', 'error', 'bye']);

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
  // `id` is emitter-minted (a UUID). Cap its length: it is the one attacker-
  // controlled field that lands raw (un-hashed) in the audit store (mesh_events
  // .message_id), so without a bound a peer could ship a ~1 MiB id (under the wire
  // line cap) of arbitrary bytes and bloat the forensic log. 128 covers a UUID with
  // room to spare; anything longer is malformed.
  if (!isNonEmptyString(obj.id) || obj.id.length > 128) return { ok: false, reason: 'bad_id' };
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
    case 'message':
      if (typeof obj.text !== 'string') return { ok: false, reason: 'message.missing_text' };
      break;
    case 'error':
      // `code` + `message` land raw in the SENDER's model context + audit — send()
      // surfaces them verbatim in the thrown Error (manager.ts). Bound both, like `id`
      // above: a hostile peer could otherwise ship a ~1 MiB error frame (under the wire
      // line cap) of arbitrary bytes to bloat the forensic log / context. Conforming
      // codes are short enum strings and messages a sentence; longer is malformed.
      if (!isNonEmptyString(obj.code) || obj.code.length > 64) {
        return { ok: false, reason: 'error.bad_code' };
      }
      if (typeof obj.message !== 'string' || obj.message.length > 256) {
        return { ok: false, reason: 'error.bad_message' };
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
// One textual peer message (request, reply, or follow-up — the type does not
// distinguish, §4). `stamp()` mints the id used only for audit/dedup.
export const makeMessage = (text: string): MeshMessage => ({
  type: 'message',
  text,
  ...stamp(),
});
export const makeError = (code: string, message: string): MeshMessage => ({
  type: 'error',
  code,
  message,
  ...stamp(),
});
export const makeBye = (): MeshMessage => ({ type: 'bye', ...stamp() });
