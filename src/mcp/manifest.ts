// Manifest canonicalization + hashing (MCP.md §3.2). PURE and
// deterministic — no SDK, no IO, no clock — so audit-replay reproduces
// the same hash and the trust history stays verifiable.
//
//   manifest_hash = sha256(canonical_json({
//     serverInfo: { name, version },
//     tools: sorted_by_name(tools),
//   }))
//
// The hash covers each tool's `name`, `description`, `inputSchema` AND
// `meta` (the _meta.agentic_cli hints). Covering `meta` is the central
// trust-integrity property: a trusted server cannot silently downgrade a
// tool's declared `writes`/`category` after the operator approved the
// manifest — any such change yields a different hash and re-prompts
// (FAILURE_MODES §14.2). `protocolVersion` is deliberately NOT hashed
// (transport detail; spec §3.2 hashes serverInfo {name, version} only).

import { createHash } from 'node:crypto';
import { canonicalJson } from '../storage/json-safe.ts';
import type { CanonicalManifest, McpManifestTool } from './types.ts';

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf-8').digest('hex');

const byName = (a: McpManifestTool, b: McpManifestTool): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

// Normalize a freshly-listed manifest: sort tools by name so the hash and
// the stored JSON are order-independent (a server reordering its
// `tools/list` output must not invalidate trust).
export const canonicalizeManifest = (input: {
  serverName: string | null;
  protocolVersion: string;
  serverVersion: string | null;
  tools: readonly McpManifestTool[];
}): CanonicalManifest => ({
  serverName: input.serverName,
  protocolVersion: input.protocolVersion,
  serverVersion: input.serverVersion,
  tools: [...input.tools].sort(byName),
});

// The exact object that gets hashed. Kept private + shared between
// `canonicalManifestJson` and `hashManifest` so the persisted
// `manifest_json` is byte-identical to what was hashed (auditable).
const hashPayload = (m: CanonicalManifest) => ({
  serverInfo: { name: m.serverName, version: m.serverVersion },
  tools: [...m.tools].sort(byName).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    meta: t.meta,
  })),
});

// The canonical JSON string that backs the hash. Stored verbatim in
// `mcp_manifest_history.manifest_json`.
export const canonicalManifestJson = (m: CanonicalManifest): string =>
  canonicalJson(hashPayload(m));

export const hashManifest = (m: CanonicalManifest): string => sha256Hex(canonicalManifestJson(m));

// Re-hash a stored `manifest_json` verbatim. The persisted string IS the
// canonical input to `hashManifest`, so a granted row must satisfy
// `hashManifestJson(row.manifest_json) === row.hash`; a mismatch means the
// row was tampered (DB write) without updating the hash — the cached-trust
// path uses this to reject such a row and re-handshake.
export const hashManifestJson = (manifestJson: string): string => sha256Hex(manifestJson);
