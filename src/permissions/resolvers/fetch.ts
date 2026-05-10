// fetch_url resolver per PERMISSION_ENGINE.md §5.
//
// Single capability: `net-egress:<host>`. The resolver refuses
// non-HTTP(S) protocols up-front — file://, gopher://, ftp://, ws(s)://
// each have their own threat models (file:// can read local FS,
// gopher:// supports SSRF via redirects, etc.) and a generic
// fetch_url tool should not be the vehicle for any of them. A
// dedicated tool per protocol would carry its own resolver; until
// those land, refuse is the safest default.

import { netEgress } from '../capabilities.ts';
import { type Resolver, type ResolverResult, registerResolver } from './registry.ts';

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const fetchResolver: Resolver = (args): ResolverResult => {
  if (!isNonEmptyString(args.url)) {
    return { kind: 'refuse', reason: "fetch_url: missing 'url' argument" };
  }
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    return { kind: 'refuse', reason: `fetch_url: invalid URL '${args.url}'` };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      kind: 'refuse',
      reason: `fetch_url: protocol '${parsed.protocol}' not supported (http/https only)`,
    };
  }
  // Lowercase the host. DNS is case-insensitive; the audit row stays
  // stable across casing variants (`API.GitHub.com` vs `api.github.com`).
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) {
    return { kind: 'refuse', reason: `fetch_url: URL has no host: '${args.url}'` };
  }
  return {
    kind: 'ok',
    capabilities: [netEgress(host)],
    confidence: 'high',
  };
};

registerResolver('fetch_url', fetchResolver);
