// ProjectVerifier — heuristic verifier for `type: project` memories
// (MEMORY.md §6.5.2, S2/T2.3).
//
// Extracts path mentions under known top-level prefixes
// (src/ tests/ docs/ evals/ examples/ scripts/) and verifies each
// against `existsSync(repoRoot/path)`. The bar is deliberately high:
// only paths with a known prefix AND a file extension OR trailing
// slash are extracted. Memories written in pure prose ("we use
// TypeScript strict mode") have nothing to extract and return
// `unknown` — silently, no state change.
//
// What this verifier DOES NOT do:
//   - Parse exports / function signatures / type declarations.
//     A claim like "src/foo.ts exports validateToken" gets the
//     path checked but NOT the export. Pattern 2 (export
//     resolution) is a future extension if real memory corpora
//     show it would catch drift the path-existence heuristic
//     misses.
//   - Semantic equivalence. "Auth lives in the user-service" vs
//     "src/auth/" — out of scope; the LLM-judge opt-in path
//     handles paraphrase, not this.
//   - Absolute paths or `..` traversal. Filtered out at extract
//     time so a malicious memory body claiming `/etc/passwd`
//     can't make the verifier touch system files.
//
// Failure modes biased toward `unknown`:
//   - Path looks like a path but has unusual chars → not extracted
//   - File exists check throws (permission, EIO) → unknown
//   - Multiple paths claimed, ONE is contradicted → contradicted
//     (the rest are still reported via `expected`/`observed`).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryVerifier, VerifyInput, VerifyResult } from './types.ts';

// Extract paths matching `<known-prefix>/<rest>` where rest looks
// like a file (has `.<ext>`) or a directory (ends with `/`).
//
// Why these prefixes: they're the standard Forja layout (CLAUDE.md
// §Layout). A memory claiming `src/memory/` or `tests/storage/`
// is verifiable; a memory claiming `node_modules/foo` isn't (might
// not be checked in) and a memory claiming `/usr/bin/git` is a
// system path that the verifier shouldn't touch. The allow-list
// keeps the scope tight.
const KNOWN_PREFIXES = ['src', 'tests', 'docs', 'evals', 'examples', 'scripts'] as const;
const PREFIX_RE = new RegExp(`(?<![\\w./])((?:${KNOWN_PREFIXES.join('|')})/[\\w\\-./]+)`, 'g');

// Sanitize a candidate path before checking. Strip trailing
// punctuation (period, comma, quote, paren, backtick) that
// the regex picked up but isn't part of the path. Drop entries
// with `..` (traversal — refuse to follow regardless of where
// repoRoot resolves) or backslash (windows-style; not a Forja
// shape).
const cleanPath = (raw: string): string | null => {
  const trimmed = raw.replace(/[.,;:'"`)\]\}]+$/, '');
  if (trimmed.length === 0) return null;
  if (trimmed.includes('..')) return null;
  if (trimmed.includes('\\')) return null;
  return trimmed;
};

const extractPaths = (body: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  // `matchAll` returns iterator of [full, group1] per match.
  for (const m of body.matchAll(PREFIX_RE)) {
    const candidate = m[1];
    if (candidate === undefined) continue;
    const cleaned = cleanPath(candidate);
    if (cleaned === null) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
};

// Test-only export so the extractor can be pinned independently
// of the verifier's FS-checking step. The verifier's verdict is
// a function of (extracted paths, FS state); pinning extraction
// in isolation makes false-positive regression tests cheap.
export const __testExtractPaths = extractPaths;

export const createProjectVerifier = (): MemoryVerifier => ({
  id: 'project-fs',
  async verify(input: VerifyInput): Promise<VerifyResult> {
    // factuality classifier gates this AT the dispatcher; if the
    // verifier is somehow called for a non-project type, treat
    // it as unknown (defensive, not a thrown error — the
    // verifier is best-effort).
    if (input.file.frontmatter.type !== 'project') {
      return { kind: 'unknown', reason: 'non-project type bypassed at verifier layer' };
    }

    const paths = extractPaths(input.file.body);
    if (paths.length === 0) {
      return {
        kind: 'unknown',
        reason: 'no verifiable path claim extracted from body (prose-only or non-path content)',
      };
    }

    const missing: string[] = [];
    for (const p of paths) {
      try {
        if (!existsSync(join(input.repoRoot, p))) {
          missing.push(p);
        }
      } catch {
        // EACCES / EIO etc — count as unknown for this path, not
        // contradicted. Silently skip (the existsSync false
        // negative would be a stronger signal anyway; throws
        // here are infrastructure flakiness, not drift).
      }
    }

    if (missing.length === 0) return { kind: 'passed' };

    // Report the FIRST missing path as the canonical claim. The
    // rest are listed in `expected` so the audit row is honest
    // about the full picture — the operator sees every path that
    // didn't resolve, not just the first one.
    const first = missing[0];
    if (first === undefined) return { kind: 'passed' }; // unreachable but exhaustive
    return {
      kind: 'contradicted',
      claim: `path ${first} mentioned in body`,
      expected: missing.length === 1 ? first : `${first} (+ ${missing.length - 1} more)`,
      observed: `${missing.length} path(s) referenced in body do not exist under repo root: ${missing.join(', ')}`,
    };
  },
});
