// Security test: case-sensitivity bypass of matchSensitivePath engine-floor
// on case-insensitive filesystems (macOS APFS default, Windows NTFS default).
//
// Threat model: operator's `.env` lives in cwd on a case-insensitive FS.
// The agent emits `write_file({ path: '.ENV', content: '<malicious>' })`.
// SEC §8.4 says the sensitive-path engine-floor MUST refuse the write
// regardless of operator policy. Today the matcher is case-sensitive and
// only relies on realpath to normalize — when realpath cannot normalize
// (target file doesn't exist yet, or the FS-case canonicalization path
// returns a name the matcher's case-sensitive globs miss), the fallback
// preserves the input case and bypasses the gate.

import { beforeAll, describe, expect, test } from 'bun:test';
import { initBashParser } from '../../src/permissions/bash-parser.ts';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import { matchSensitivePath } from '../../src/permissions/sensitive-paths.ts';

beforeAll(async () => {
  await initBashParser();
});

describe('SEC §8.4 case-sensitivity bypass', () => {
  test('matchSensitivePath is case-insensitive (post-fix)', () => {
    // Each of these resolves to the same inode as the lowercase form
    // on macOS APFS / Windows NTFS. The engine-floor must hold on every
    // platform; the matcher lowercases both its input AND the patterns
    // before matching.
    expect(matchSensitivePath('.env')).toBe('.env');
    expect(matchSensitivePath('.ENV')).toBe('.env');
    expect(matchSensitivePath('.Env')).toBe('.env');
    expect(matchSensitivePath('id_RSA')).toBe('id_rsa*');
    expect(matchSensitivePath('CREDENTIALS.json')).toBe('*credentials*.json');
    expect(matchSensitivePath('.SSH/known_hosts')).toBe('.ssh/**');
    expect(matchSensitivePath('production.PEM')).toBe('*.pem');
  });

  test('mixed-case PATTERNS still match (both sides lowercased)', () => {
    // `GoogleService-Info.plist` is the one deny-list entry that is NOT
    // authored lowercase. Lowercasing only the input would make this
    // pattern dead — a §8.4 bypass in the opposite direction (and the
    // real-cased file would lose its own protection too). The match must
    // hold for the canonical case AND any other casing.
    expect(matchSensitivePath('GoogleService-Info.plist')).toBe('GoogleService-Info.plist');
    expect(matchSensitivePath('ios/Runner/GoogleService-Info.plist')).toBe(
      'GoogleService-Info.plist',
    );
    expect(matchSensitivePath('googleservice-info.PLIST')).toBe('GoogleService-Info.plist');
  });

  test('engine refuses .env (baseline)', () => {
    const eng = createPermissionEngine(
      { defaults: { mode: 'strict' }, tools: { write_file: { allow_paths: ['**'] } } },
      { cwd: '/proj', home: '/home/op' },
    );
    const d = eng.check('write_file', 'fs.write', { path: '.env' });
    expect(d.kind).toBe('deny');
  });

  test('engine ALLOWS .ENV (BUG: bypasses SEC §8.4 engine-floor)', () => {
    const eng = createPermissionEngine(
      { defaults: { mode: 'strict' }, tools: { write_file: { allow_paths: ['**'] } } },
      { cwd: '/proj', home: '/home/op' },
    );
    const d = eng.check('write_file', 'fs.write', { path: '.ENV' });
    // Should be 'deny' with SEC §8.4 reason. Today it is NOT.
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.reason).toContain('SEC §8.4');
    }
  });

  test('engine ALLOWS deep/.ENV.PRODUCTION (same root cause)', () => {
    const eng = createPermissionEngine(
      { defaults: { mode: 'strict' }, tools: { write_file: { allow_paths: ['**'] } } },
      { cwd: '/proj', home: '/home/op' },
    );
    const d = eng.check('write_file', 'fs.write', { path: 'deep/.ENV.PRODUCTION' });
    expect(d.kind).toBe('deny');
  });
});
