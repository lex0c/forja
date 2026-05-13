// fetch_url resolver per PERMISSION_ENGINE.md §5.
//
// Single capability: `net-egress:<host>`. The resolver refuses
// non-HTTP(S) protocols up-front — file://, gopher://, ftp://, ws(s)://
// each have their own threat models (file:// can read local FS,
// gopher:// supports SSRF via redirects, etc.) and a generic
// fetch_url tool should not be the vehicle for any of them. A
// dedicated tool per protocol would carry its own resolver; until
// those land, refuse is the safest default.
//
// Slice 129 (R5 SSRF P0): per SECURITY_GUIDELINE.md §9.1.6 a
// blocklist of unconditional denies must run BEFORE operator
// policy can override. Cloud metadata services (AWS/GCP/Azure),
// loopback, link-local, RFC1918, IPv6 ULA — any of these
// reachable from the inside of an agent is a credential-exfil
// or lateral-movement vector. Spec says "Override de deny_hosts
// é proibido em config"; the resolver-level refuse short-circuits
// before engine.check consults the operator's allow/deny lists,
// so it IS unconditional.
//
// Same path covers wait_for's `port_open` and `http_response`
// leaves — both route through `ctx.permissionCheck('fetch_url',
// 'web.fetch', { url })` (see src/tools/builtin/wait-for.ts) so
// the SSRF blocklist gate them all.

import { netEgress } from '../capabilities.ts';
import { type Resolver, type ResolverResult, registerResolver } from './registry.ts';

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// SSRF blocklist. Returns a refuse-reason when host targets a
// local/private/metadata resource; null when host is acceptable
// for further engine consideration.
//
// Patterns (per spec §9.1.6):
//   - DNS: `localhost`, `*.localhost`, cloud metadata FQDNs
//   - IPv4: 127.0.0.0/8 (loopback), 0.0.0.0 (unspecified),
//     169.254.0.0/16 (link-local; includes 169.254.169.254
//     AWS/GCP metadata), 10/8 + 172.16/12 + 192.168/16 (RFC1918),
//     100.64/10 (CGNAT), 224/4 (multicast)
//   - IPv6: ::1 (loopback), :: (unspecified), fe80::/10 (link-local),
//     fc00::/7 (unique local; fc + fd prefixes)
//   - IPv4-mapped IPv6: `::ffff:127.0.0.1` and friends
const checkSsrfBlocklist = (rawHost: string): string | null => {
  let h = rawHost.toLowerCase();
  // Strip IPv6 brackets if present — URL.hostname behavior varies
  // across runtimes (Node returns with brackets; the WHATWG URL
  // spec returns without). Normalize.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // Slice 139 C2: strip trailing dot (FQDN absolute form).
  // `new URL('http://localhost.').hostname` returns the literal
  // `localhost.` — DNS resolves it to 127.0.0.1 via root-anchor
  // expansion, but pre-fix the string comparisons below missed it.
  // Same threat for `metadata.google.internal.`, `metadata.azure.com.`,
  // etc. Stripping once at the boundary normalizes every comparison
  // below to the canonical no-trailing-dot form.
  if (h.endsWith('.')) h = h.slice(0, -1);

  // DNS names that always lead to local / metadata services.
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return 'localhost / loopback FQDN';
  }
  if (h === 'metadata.google.internal') return 'GCP metadata service';
  if (h === 'metadata.azure.com' || h.endsWith('.metadata.azure.com')) {
    return 'Azure metadata service';
  }
  if (h === 'metadata') return 'bare-name metadata host';

  // IPv4 literal.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4 !== null) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0) return 'IPv4 unspecified 0.0.0.0/8';
    if (a === 127) return 'IPv4 loopback 127.0.0.0/8';
    if (a === 169 && b === 254) {
      return 'IPv4 link-local 169.254.0.0/16 (includes AWS/GCP metadata 169.254.169.254)';
    }
    if (a === 10) return 'IPv4 RFC1918 private 10.0.0.0/8';
    if (a === 172 && b >= 16 && b <= 31) return 'IPv4 RFC1918 private 172.16.0.0/12';
    if (a === 192 && b === 168) return 'IPv4 RFC1918 private 192.168.0.0/16';
    if (a >= 224 && a <= 239) return 'IPv4 multicast 224.0.0.0/4';
    if (a === 100 && b >= 64 && b <= 127) return 'IPv4 CGNAT 100.64.0.0/10';
    return null;
  }

  // IPv6 literal — after bracket strip.
  // Loopback / unspecified canonical and expanded forms.
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return 'IPv6 loopback ::1';
  if (h === '::' || h === '0:0:0:0:0:0:0:0') return 'IPv6 unspecified ::';
  // IPv4-mapped IPv6 — `::ffff:a.b.c.d` in dotted form OR
  // `::ffff:hhhh:hhhh` (or compact `::ffff:hhhh`) in pure-hex
  // form. The WHATWG URL parser normalizes the dotted form to
  // hex (`new URL('http://[::ffff:127.0.0.1]/').hostname` →
  // `[::ffff:7f00:1]`), so both shapes reach the resolver. Decode
  // each pair of hex octets back to dotted IPv4 then recurse.
  if (h.startsWith('::ffff:')) {
    const mapped = h.slice('::ffff:'.length);
    // Dotted form (defensive — most runtimes won't surface this).
    if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(mapped)) {
      const inner = checkSsrfBlocklist(mapped);
      if (inner !== null) return `IPv4-mapped IPv6 of ${inner}`;
    }
    // Hex form: one or two hex groups (each 1-4 chars), e.g.,
    // `7f00:1` or `0:1`. Decode into 32 bits, then back to a.b.c.d.
    const hexMatch = /^([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/i.exec(mapped);
    if (hexMatch !== null) {
      const high = Number.parseInt(hexMatch[1] ?? '0', 16);
      const low = Number.parseInt(hexMatch[2] ?? '0', 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        const a = (high >> 8) & 0xff;
        const b = high & 0xff;
        const c = (low >> 8) & 0xff;
        const d = low & 0xff;
        const dotted = `${a}.${b}.${c}.${d}`;
        const inner = checkSsrfBlocklist(dotted);
        if (inner !== null) return `IPv4-mapped IPv6 (hex form) of ${inner}`;
      }
    }
  }
  // fe80::/10 link-local (first 10 bits = 1111 1110 10 → fe80..febf).
  if (/^fe[89ab][0-9a-f]:/i.test(h) || /^fe[89ab][0-9a-f]$/i.test(h)) {
    return 'IPv6 link-local fe80::/10';
  }
  // fc00::/7 unique local (first 7 bits = 1111 110 → fc and fd prefixes).
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^f[cd][0-9a-f]{2}$/i.test(h)) {
    return 'IPv6 unique local fc00::/7';
  }

  return null;
};

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
  // Slice 129 (R5 SSRF P0): unconditional SSRF blocklist. Fires
  // BEFORE engine.check consults operator policy — operator cannot
  // override this gate via `allow_hosts`/bypass.
  const ssrfReason = checkSsrfBlocklist(host);
  if (ssrfReason !== null) {
    return {
      kind: 'refuse',
      reason: `fetch_url: host '${host}' is in the SSRF blocklist (${ssrfReason}); see SECURITY_GUIDELINE.md §9.1.6`,
    };
  }
  return {
    kind: 'ok',
    capabilities: [netEgress(host)],
    confidence: 'high',
  };
};

registerResolver('fetch_url', fetchResolver);
