export const migration082McpServerRevokedAt = {
  id: 82,
  name: '082-mcp-server-revoked-at',
  // Operator revocation (`/mcp revoke`) must SURVIVE a relaunch. The grant lives
  // in the append-only `mcp_manifest_history` forever, so `init`'s cached-trust
  // path would otherwise re-register a revoked server's tools on the next boot.
  // A nullable `revoked_at` on the (mutable) state row records the revocation:
  // `init` skips the cache while it is set, and `/mcp reconnect` clears it on a
  // fresh re-trust. Recording the revocation on the STATE table keeps the
  // history append-only and sidesteps the `UNIQUE(server_name, hash)` (081) that
  // forbids a second decision row for an already-granted hash.
  //
  // - revoked_at (INTEGER, nullable): epoch-ms of the revocation; NULL otherwise.
  // - No index: the only read is "this server by name" (PK on name, 081).
  // - Existing rows get NULL (never revoked). The repo writes it on revoke and
  //   clears it on re-trust, so schema + runtime stay aligned with no backfill.
  sql: `
    ALTER TABLE mcp_servers ADD COLUMN revoked_at INTEGER;
  `,
} as const;
