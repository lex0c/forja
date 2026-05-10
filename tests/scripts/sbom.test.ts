import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBom,
  generateSbom,
  lockfileToComponents,
  parseBunLock,
  parseSpec,
  summarize,
} from '../../scripts/sbom.ts';

const FIXTURE_PACKAGE_JSON = JSON.stringify({
  name: 'forja',
  version: '0.0.0',
  dependencies: {
    direct: '^1.0.0',
    '@scope/scoped': '^2.0.0',
  },
  devDependencies: {
    'dev-only': '^1.0.0',
  },
});

// bun.lock: trailing commas allowed, integrity entries optional, scoped
// names supported. Designed to exercise the prod-set walk (`direct`
// pulls in `transitive`; `dev-only` should NOT appear in the SBOM).
const FIXTURE_BUN_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "forja",
      "dependencies": {
        "direct": "^1.0.0",
        "@scope/scoped": "^2.0.0",
      },
      "devDependencies": {
        "dev-only": "^1.0.0",
      },
    },
  },
  "packages": {
    "direct": ["direct@1.2.3", "", { "dependencies": { "transitive": "^0.1.0" } }, "sha512-${'A'.repeat(86)}=="],
    "@scope/scoped": ["@scope/scoped@2.0.0", "", {}, "sha512-${'B'.repeat(86)}=="],
    "transitive": ["transitive@0.1.0", "", {}, "sha512-${'C'.repeat(86)}=="],
    "dev-only": ["dev-only@1.0.0", "", {}, "sha512-${'D'.repeat(86)}=="],
  },
}
`;

describe('parseSpec', () => {
  test('handles plain name@version', () => {
    expect(parseSpec('react@18.0.0')).toEqual({ name: 'react', version: '18.0.0' });
  });

  test('handles scoped names by anchoring on the last @', () => {
    expect(parseSpec('@anthropic-ai/sdk@0.91.1')).toEqual({
      name: '@anthropic-ai/sdk',
      version: '0.91.1',
    });
  });

  test('returns null for malformed specs', () => {
    expect(parseSpec('no-version-here')).toBeNull();
  });
});

describe('parseBunLock', () => {
  test('strips trailing commas and parses', () => {
    const lock = parseBunLock(FIXTURE_BUN_LOCK);
    expect(Object.keys(lock.packages ?? {}).length).toBe(4);
    expect(lock.workspaces?.['']?.dependencies?.direct).toBe('^1.0.0');
  });

  test('throws on non-JSON garbage', () => {
    expect(() => parseBunLock('not json {}')).toThrow();
  });
});

describe('lockfileToComponents', () => {
  test('emits one component per package, sorted by purl, with sha512 hashes', () => {
    const lock = parseBunLock(FIXTURE_BUN_LOCK);
    const components = lockfileToComponents(lock);
    expect(components.length).toBe(4);
    // Sorted by purl: %40scope < direct < dev-only < transitive in
    // codepoint order — verify the sort is stable and deterministic.
    const purls = components.map((c) => c.purl);
    expect(purls).toEqual([...purls].sort());
    // Each component carries a hex-encoded SHA-512 derived from
    // bun.lock's base64 integrity field. 64 bytes → 128 hex chars.
    for (const c of components) {
      expect(c.hashes?.[0]?.alg).toBe('SHA-512');
      expect(c.hashes?.[0]?.content).toMatch(/^[0-9a-f]{128}$/);
    }
  });

  test('encodes scope as %40 in PURL', () => {
    const lock = parseBunLock(FIXTURE_BUN_LOCK);
    const components = lockfileToComponents(lock);
    const scoped = components.find((c) => c.name === '@scope/scoped');
    expect(scoped?.purl).toBe('pkg:npm/%40scope/scoped@2.0.0');
  });
});

describe('buildBom', () => {
  test('filters out devDeps from the production closure', () => {
    const lock = parseBunLock(FIXTURE_BUN_LOCK);
    const bom = buildBom(lock, 'forja', '0.0.0');
    const names = bom.components.map((c) => c.name).sort();
    // direct + @scope/scoped + transitive (pulled by direct), but NOT dev-only
    expect(names).toEqual(['@scope/scoped', 'direct', 'transitive']);
  });

  test('walks transitive deps from the lockfile entries', () => {
    const lock = parseBunLock(FIXTURE_BUN_LOCK);
    const bom = buildBom(lock, 'forja', '0.0.0');
    expect(bom.components.find((c) => c.name === 'transitive')).toBeDefined();
  });

  test('emits CycloneDX 1.5 bom shape', () => {
    const lock = parseBunLock(FIXTURE_BUN_LOCK);
    const bom = buildBom(lock, 'forja', '0.1.0');
    expect(bom.bomFormat).toBe('CycloneDX');
    expect(bom.specVersion).toBe('1.5');
    expect(bom.metadata.component.name).toBe('forja');
    expect(bom.metadata.component.version).toBe('0.1.0');
  });

  test('produces deterministic output across two runs', () => {
    const lock = parseBunLock(FIXTURE_BUN_LOCK);
    const a = JSON.stringify(buildBom(lock, 'forja', '0.0.0'));
    const b = JSON.stringify(buildBom(lock, 'forja', '0.0.0'));
    expect(a).toBe(b);
  });
});

describe('generateSbom + summarize', () => {
  const setup = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-sbom-'));
    writeFileSync(join(dir, 'package.json'), FIXTURE_PACKAGE_JSON);
    writeFileSync(join(dir, 'bun.lock'), FIXTURE_BUN_LOCK);
    return dir;
  };

  test('writes sbom.cdx.json into the dist dir', () => {
    const cwd = setup();
    try {
      const dist = join(cwd, 'dist');
      const result = generateSbom({ distDir: dist, cwd });
      expect(result.path).toBe(join(dist, 'sbom.cdx.json'));
      const written = readFileSync(result.path, 'utf-8');
      const doc = JSON.parse(written);
      expect(doc.bomFormat).toBe('CycloneDX');
      // Trailing newline so the file is a "clean" text file.
      expect(written.endsWith('\n')).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('summarize returns a one-line summary', () => {
    const cwd = setup();
    try {
      const { path } = generateSbom({ distDir: join(cwd, 'dist'), cwd });
      const text = summarize(path);
      expect(text).toContain('CycloneDX 1.5');
      expect(text).toContain('component(s)');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('summarize rejects non-CycloneDX documents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-sbom-'));
    try {
      const path = join(dir, 'sbom.cdx.json');
      writeFileSync(path, JSON.stringify({ bomFormat: 'SPDX' }));
      expect(() => summarize(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
