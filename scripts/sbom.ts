// SBOM generator (SECURITY_GUIDELINE.md §7.2 line 307,
// PERFORMANCE.md §18.5 line 630).
//
// Emits a CycloneDX 1.5 JSON document at `dist/sbom.cdx.json` covering
// the production dependency closure declared in `bun.lock`. One SBOM
// per release is enough — the dependency graph is identical across
// platform targets (Bun bundles the same JS for every triple); what
// differs is the embedded runtime, recorded as a separate component.
//
// Why hand-rolled instead of `@cyclonedx/cyclonedx-npm`: that tool
// shells out to `npm ls` and refuses to run under Bun's package
// manager. `@cyclonedx/cdxgen` works but pulls 700+ deps and runs
// under Node — installing Node just to generate one JSON file is
// disproportionate. `bun.lock` is small, stable, and easy to walk.
//
// Deterministic output: components sorted by purl, JSON pretty-printed
// with stable key order, no timestamps, no random identifiers. Two
// runs at the same lockfile produce byte-identical SBOMs (verified by
// the reproducibility check downstream).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Public so the checksums + release-asset filters can include the
// SBOM by name without duplicating the literal. Renaming here moves
// the filename in every consumer (provided they import this).
export const SBOM_FILENAME = 'sbom.cdx.json';

// CycloneDX spec version emitted. 1.5 is the most-deployed stable
// (1.6 exists but tooling support is still patchy as of mid-2026).
const CDX_SPEC_VERSION = '1.5';

// ---------- bun.lock parsing ----------

// `bun.lock` is JSONC-ish: standard JSON plus trailing commas before
// `}` / `]`. Bun's runtime parser accepts these directly when reading
// the lockfile, but `JSON.parse` does not. Strip the trailing commas
// before handing to the standard parser. The regex matches a comma
// followed by optional whitespace and a closing bracket, replacing
// it with the bracket alone — safe under JSON's grammar because a
// trailing comma is never legal there.
const stripTrailingCommas = (text: string): string => text.replace(/,(\s*[}\]])/g, '$1');

interface BunLockfile {
  workspaces?: Record<string, { dependencies?: Record<string, string> }>;
  // Each entry is a 4-tuple: [spec, registry, info, integrity]
  // We only need the spec (which carries the resolved name@version)
  // and the integrity (sha512 hash of the tarball).
  packages?: Record<string, [string, string, unknown, string]>;
}

export const parseBunLock = (text: string): BunLockfile =>
  JSON.parse(stripTrailingCommas(text)) as BunLockfile;

// ---------- CycloneDX shaping ----------

export interface Component {
  type: 'library' | 'application' | 'framework';
  'bom-ref': string;
  name: string;
  version: string;
  purl: string;
  // Optional. CycloneDX accepts hashes inline; we attach the bun.lock
  // integrity (sha512) when present so consumers can verify each
  // component without re-fetching from the registry.
  hashes?: { alg: 'SHA-512'; content: string }[];
}

const PKG_SPEC_RE = /^(.+?)@([^@]+)$/;

// Encode a name+version into a Package URL (PURL) for npm. Handles
// scoped names (`@scope/name`) by URL-encoding the leading `@` so the
// PURL grammar is unambiguous: `pkg:npm/@scope/name@1.2.3` → encoded
// as `pkg:npm/%40scope/name@1.2.3`. Most consumers tolerate either,
// but the encoded form is what the spec mandates.
const toPurl = (name: string, version: string): string => {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
};

// Derive (name, version) from a bun.lock spec string like
// `@scope/name@1.2.3`. The first `@` is part of the scope, NOT the
// name/version separator, so we anchor on the LAST `@`.
export const parseSpec = (spec: string): { name: string; version: string } | null => {
  // Use the regex but constrained: match the longest name (greedy)
  // followed by `@` and a non-`@` version. For scoped names this is
  // implicit because the only `@` after position 0 is the separator.
  const m = PKG_SPEC_RE.exec(spec);
  if (m === null) return null;
  // Edge case: a leading `@` followed by NO additional `@` (illegal
  // in the npm grammar). The regex above wouldn't match in that
  // case so this guard is for clarity, not correctness.
  return { name: m[1] as string, version: m[2] as string };
};

// Convert a parsed lockfile into a sorted, deduped component list.
// Sort by purl so two runs at the same lockfile produce identical
// JSON output.
export const lockfileToComponents = (lock: BunLockfile): Component[] => {
  const out: Map<string, Component> = new Map();
  const packages = lock.packages ?? {};
  for (const [, entry] of Object.entries(packages)) {
    const spec = entry[0];
    const integrity = entry[3];
    const parsed = parseSpec(spec);
    if (parsed === null) continue;
    const purl = toPurl(parsed.name, parsed.version);
    if (out.has(purl)) continue;
    const component: Component = {
      type: 'library',
      'bom-ref': purl,
      name: parsed.name,
      version: parsed.version,
      purl,
    };
    // bun.lock integrity strings are typically `sha512-<base64>=`.
    // Convert to hex for CycloneDX; if the prefix is missing or the
    // payload doesn't decode, skip the hash rather than emit garbage.
    if (typeof integrity === 'string' && integrity.startsWith('sha512-')) {
      const b64 = integrity.slice('sha512-'.length);
      try {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length === 64) {
          component.hashes = [{ alg: 'SHA-512', content: buf.toString('hex') }];
        }
      } catch {
        // malformed base64 — skip the hash, keep the component
      }
    }
    out.set(purl, component);
  }
  return [...out.values()].sort((a, b) => a.purl.localeCompare(b.purl));
};

// Filter components down to the production closure: anything reachable
// from the root workspace's `dependencies`, transitively. devDeps in
// bun.lock get tagged at the workspace level, but transitive resolution
// flattens them into `packages`. Filtering by direct-dep closure keeps
// the SBOM aligned with what actually ships in the binary.
//
// This is intentionally simple: walk direct deps, collect their
// transitive deps from the lockfile entries (info[2]). The spec for a
// component-with-deps looks like:
//   ["pkg@1.2.3", "", { "dependencies": {...} }, "sha512-..."]
const buildProdSet = (lock: BunLockfile): Set<string> => {
  const root = lock.workspaces?.[''];
  const directDeps = root?.dependencies ?? {};
  const set = new Set<string>(Object.keys(directDeps));
  const packages = lock.packages ?? {};

  // Iteratively expand the set using the `dependencies` field on
  // each lockfile entry. Bounded by the number of unique packages,
  // so termination is guaranteed.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...set]) {
      const entry = packages[name];
      if (!entry) continue;
      const info = entry[2] as { dependencies?: Record<string, string> } | undefined;
      const trans = info?.dependencies;
      if (!trans) continue;
      for (const child of Object.keys(trans)) {
        if (!set.has(child)) {
          set.add(child);
          changed = true;
        }
      }
    }
  }
  return set;
};

export interface BomDocument {
  bomFormat: 'CycloneDX';
  specVersion: string;
  version: 1;
  metadata: {
    component: { type: 'application'; name: string; version: string };
    tools: { name: string; version: string }[];
  };
  components: Component[];
}

// The compiled binary embeds the Bun runtime (+ JSC) — ~50-90 MiB of the
// artifact, larger than the entire npm closure. An SBOM that omits it
// misrepresents what actually ships, so we record it as a `framework`
// component. The version is injected (from `Bun.version` at generate
// time) rather than read here, so `buildBom` stays pure and
// deterministic. The PURL targets the upstream source repo because Bun
// distributes as a GitHub release, not an npm package.
export const bunRuntimeComponent = (version: string): Component => {
  const purl = `pkg:github/oven-sh/bun@${version}`;
  return {
    type: 'framework',
    'bom-ref': purl,
    name: 'bun',
    version,
    purl,
  };
};

export const buildBom = (
  lock: BunLockfile,
  appName: string,
  appVersion: string,
  runtimeVersion: string,
): BomDocument => {
  const prodNames = buildProdSet(lock);
  const deps = lockfileToComponents(lock).filter((c) => prodNames.has(c.name));
  // Merge the npm closure with the embedded runtime, then re-sort by
  // purl so output stays byte-identical regardless of insertion order
  // (the reproducibility check downstream depends on this).
  const components = [bunRuntimeComponent(runtimeVersion), ...deps].sort((a, b) =>
    a.purl.localeCompare(b.purl),
  );
  return {
    bomFormat: 'CycloneDX',
    specVersion: CDX_SPEC_VERSION,
    version: 1,
    metadata: {
      component: { type: 'application', name: appName, version: appVersion },
      tools: [{ name: 'forja-sbom', version: '1.0.0' }],
    },
    components,
  };
};

// ---------- IO ----------

interface PackageJson {
  name: string;
  version: string;
}

export interface GenerateOptions {
  distDir: string;
  // Optional override for tests; defaults to repo root.
  cwd?: string;
}

export const generateSbom = (opts: GenerateOptions): { path: string; bom: BomDocument } => {
  if (!existsSync(opts.distDir)) mkdirSync(opts.distDir, { recursive: true });
  const cwd = opts.cwd ?? process.cwd();
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as PackageJson;
  const lock = parseBunLock(readFileSync(join(cwd, 'bun.lock'), 'utf-8'));
  // `Bun.version` is the runtime compiling the binary — the one that
  // gets embedded. Recorded in the SBOM via the framework component.
  const bom = buildBom(lock, pkg.name, pkg.version, Bun.version);
  const out = join(opts.distDir, SBOM_FILENAME);
  // Pretty-print with two-space indent, trailing newline. Stable
  // key order is preserved by JSON.stringify on insertion-ordered
  // objects, which is what `buildBom` produces.
  writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
  return { path: out, bom };
};

// Read the generated SBOM and surface a one-line summary on stdout
// so a CI log can be scanned without opening the JSON. Validates
// shape minimally — full schema validation belongs to a downstream
// policy controller, not here.
export const summarize = (sbomPath: string): string => {
  const raw = readFileSync(sbomPath, 'utf-8');
  const doc = JSON.parse(raw) as {
    bomFormat?: string;
    specVersion?: string;
    components?: unknown[];
  };
  if (doc.bomFormat !== 'CycloneDX') {
    throw new Error(`SBOM at ${sbomPath} is not CycloneDX (bomFormat=${doc.bomFormat})`);
  }
  const componentCount = Array.isArray(doc.components) ? doc.components.length : 0;
  return `CycloneDX ${doc.specVersion} — ${componentCount} component(s) at ${sbomPath}`;
};

const parseFlag = (argv: readonly string[], name: string, dflt: string): string => {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return dflt;
};

const main = (): void => {
  const argv = process.argv.slice(2);
  const distDir = parseFlag(argv, 'dist', 'dist');
  const { path } = generateSbom({ distDir });
  process.stdout.write(`${summarize(path)}\n`);
};

if (import.meta.main) main();
