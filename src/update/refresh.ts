import type { DB } from '../storage/db.ts';
import { getUpdateCheck, recordUpdateProbe } from '../storage/repos/update-check.ts';
import { shouldRefresh } from './notice.ts';
import { formatSemver, parseSemver } from './semver.ts';

// Canonical release feed. GitHub Releases is the single verified channel
// (SECURITY_GUIDELINE §11.4). Build-time constants — never derived from
// `git remote`, which could point at a fork or be absent.
const REPO_SLUG = 'lex0c/forja';
export const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;

// Human-facing releases page the notice points at. It's the current update
// path (install.sh re-run / npm / assets) until the `forja update` subcommand
// lands (spec §11.1, phase 2) — a constant, so no per-tag v-prefix hazard.
export const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases/latest`;

// The refresh must never make boot feel slow, and it runs in the background
// anyway — a slow/hanging server is treated as "no signal".
const PROBE_TIMEOUT_MS = 2000;
// The API response is untrusted (§0.4); a hostile endpoint must not stream us an
// unbounded body. But `/releases/latest` returns the WHOLE release object — the
// --generate-notes body (GitHub caps notes at ~125 KB) plus every asset's
// metadata (binaries, SBOM, SHA256SUMS) — so a 64 KiB cap silently dropped valid
// large releases before extractTagName ever ran. 1 MiB covers any real GitHub
// release object with wide margin while still bounding a truly hostile body.
const MAX_BODY_BYTES = 1024 * 1024;

// Reads the response body up to `max` bytes, returning null if it exceeds the
// cap (treated as no signal) — never buffers an unbounded stream.
const readCapped = async (res: Response, max: number): Promise<string | null> => {
  const reader = res.body?.getReader();
  // No stream (empty/absent body) → no signal. Never fall back to an uncapped
  // res.text() on an untrusted endpoint (§0.4).
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
};

const extractTagName = (body: string): string | null => {
  try {
    const json = JSON.parse(body) as { tag_name?: unknown };
    return typeof json.tag_name === 'string' ? json.tag_name : null;
  } catch {
    return null;
  }
};

// Fetches the latest STABLE release version (GitHub `/releases/latest` excludes
// prereleases by design), or null on ANY failure — network error, timeout,
// non-2xx, oversized/garbled body, or a tag that isn't valid semver. Fail-
// silent: the caller never surfaces an error. No token, no PII, generic
// User-Agent (the public endpoint needs no auth); redirects are refused so the
// probe can't be bounced off the canonical host (§11.4).
export const fetchLatestVersion = async (
  url: string = RELEASES_LATEST_URL,
  signal?: AbortSignal,
): Promise<string | null> => {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const composite = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: composite,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'forja-update-check' },
    });
    if (!res.ok) return null;
    const body = await readCapped(res, MAX_BODY_BYTES);
    if (body === null) return null;
    const tag = extractTagName(body);
    if (tag === null) return null;
    const parsed = parseSemver(tag);
    return parsed === null ? null : formatSemver(parsed);
  } catch {
    return null;
  }
};

// Background refresh: if the throttle allows, probe the network and record the
// result. Fail-silent, never throws — designed to be fire-and-forget off the
// boot path (its result feeds the NEXT session's notice, §11.4). `now`, the
// interval and the URL are injectable for tests.
export const refreshUpdateCache = async (
  db: DB,
  opts: { now: number; intervalMs?: number; url?: string; signal?: AbortSignal },
): Promise<void> => {
  try {
    const state = getUpdateCheck(db);
    if (!shouldRefresh(state, opts.now, opts.intervalMs)) return;
    const latest = await fetchLatestVersion(opts.url, opts.signal);
    if (latest === null) return; // failed probe → record nothing, retry next boot
    recordUpdateProbe(db, opts.now, latest);
  } catch {
    // An update probe must never surface as a boot error.
  }
};
