import { describe, expect, test } from 'bun:test';
import {
  activeProfile,
  appDirName,
  appDirNames,
  isValidProfile,
  projectDirName,
  projectDirNames,
} from '../../src/config/app-namespace.ts';

// The app-namespace keystone: every on-disk resolver routes its segment through
// these helpers, so a bug here mis-files the entire install. `FORJA_PROFILE`
// (or `--profile`, which sets it) selects an ISOLATED namespace; absence is the
// canonical `forja` / `.forja`, byte-identical to pre-profile behavior.

describe('isValidProfile', () => {
  test('accepts lowercase alphanumeric + non-leading hyphen', () => {
    expect(isValidProfile('dev')).toBe(true);
    expect(isValidProfile('dev2')).toBe(true);
    expect(isValidProfile('my-dev-1')).toBe(true);
    expect(isValidProfile('a')).toBe(true);
  });

  test('rejects the empty string', () => {
    expect(isValidProfile('')).toBe(false);
  });

  test('rejects a leading hyphen (would read as a flag / collapses the segment)', () => {
    expect(isValidProfile('-dev')).toBe(false);
  });

  test('rejects path-traversal + separator bytes', () => {
    expect(isValidProfile('..')).toBe(false);
    expect(isValidProfile('a/b')).toBe(false);
    expect(isValidProfile('a\\b')).toBe(false);
    expect(isValidProfile('a.b')).toBe(false);
  });

  test('rejects uppercase + whitespace (case-sensitive path segment)', () => {
    expect(isValidProfile('Dev')).toBe(false);
    expect(isValidProfile('de v')).toBe(false);
  });
});

describe('appDirName / projectDirName', () => {
  test('no profile ⇒ canonical segments', () => {
    expect(appDirName({})).toBe('forja');
    expect(projectDirName({})).toBe('.forja');
  });

  test('empty FORJA_PROFILE is treated as no profile', () => {
    expect(appDirName({ FORJA_PROFILE: '' })).toBe('forja');
    expect(projectDirName({ FORJA_PROFILE: '' })).toBe('.forja');
  });

  test('a profile relocates BOTH the user-level and project segments', () => {
    expect(appDirName({ FORJA_PROFILE: 'dev' })).toBe('forja-dev');
    expect(projectDirName({ FORJA_PROFILE: 'dev' })).toBe('.forja-dev');
  });

  test('throws on a malformed profile rather than silently using the real namespace', () => {
    // A typo'd profile that fell back to `forja` would defeat the isolation the
    // operator asked for — fail loud instead.
    expect(() => appDirName({ FORJA_PROFILE: '../escape' })).toThrow(/invalid FORJA_PROFILE/);
    expect(() => projectDirName({ FORJA_PROFILE: 'Bad' })).toThrow(/invalid FORJA_PROFILE/);
  });
});

describe('activeProfile', () => {
  test('null when unset / empty, the name when set', () => {
    expect(activeProfile({})).toBeNull();
    expect(activeProfile({ FORJA_PROFILE: '' })).toBeNull();
    expect(activeProfile({ FORJA_PROFILE: 'dev' })).toBe('dev');
  });
});

describe('appDirNames (security-list baseline)', () => {
  test('no profile ⇒ canonical only', () => {
    expect(appDirNames({})).toEqual(['forja']);
  });

  test('profile ⇒ canonical FIRST, then the profile variant (protect both)', () => {
    // The sandbox hide-paths / protected-paths lists build from this so a dev
    // sandbox masks BOTH the real `forja` state AND the dev `forja-dev` state.
    expect(appDirNames({ FORJA_PROFILE: 'dev' })).toEqual(['forja', 'forja-dev']);
  });
});

describe('projectDirNames (project escalate-list baseline)', () => {
  test('no profile ⇒ canonical only', () => {
    expect(projectDirNames({})).toEqual(['.forja']);
  });

  test('profile ⇒ canonical `.forja` FIRST, then the profile variant', () => {
    // The cwd escalate-on-write list builds from this so a profiled run STILL
    // escalates writes to the operator's real `.forja/` (no silent edit of
    // canonical project policy/sessions), plus its own `.forja-<profile>/`.
    expect(projectDirNames({ FORJA_PROFILE: 'dev' })).toEqual(['.forja', '.forja-dev']);
  });
});
