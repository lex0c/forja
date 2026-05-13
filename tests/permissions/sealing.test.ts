import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import {
  type SealEntry,
  createGitAnchoredSealer,
  createWormFileSealer,
  defaultGitAnchoredFactory,
  defaultWormFileFactory,
  factoryForSealMode,
  verifySealAgainstChain,
} from '../../src/permissions/sealing.ts';
import { MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-seal-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// In-memory fake fs — captures append() calls + drives exists/read
// off the same content map so list() sees what append() wrote.
type FakeFs = {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  append: (p: string, content: string) => void;
  ensureDir: (dir: string) => void;
  // Spies:
  appendCalls: Array<{ path: string; content: string }>;
  ensureDirCalls: string[];
  // Direct access to the inner buffer (for tampering tests).
  contents: Map<string, string>;
};

const makeFakeFs = (): FakeFs => {
  const contents = new Map<string, string>();
  const appendCalls: Array<{ path: string; content: string }> = [];
  const ensureDirCalls: string[] = [];
  return {
    contents,
    appendCalls,
    ensureDirCalls,
    exists: (p: string) => contents.has(p),
    read: (p: string) => contents.get(p) ?? '',
    append: (p: string, content: string) => {
      appendCalls.push({ path: p, content });
      contents.set(p, (contents.get(p) ?? '') + content);
    },
    ensureDir: (dir: string) => {
      ensureDirCalls.push(dir);
    },
  };
};

describe('createWormFileSealer — append', () => {
  test('first append creates the file + invokes onCreate exactly once', () => {
    const fs = makeFakeFs();
    const onCreateCalls: string[] = [];
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      onCreate: (p) => onCreateCalls.push(p),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    const r = sealer.append({ seq: 1, ts: 1000, hash: 'sha256:abc123' });
    expect(r).toEqual({ ok: true });
    expect(fs.appendCalls).toHaveLength(1);
    expect(fs.appendCalls[0]?.content).toBe('seq=1\tts=1000\thash=sha256:abc123\n');
    expect(onCreateCalls).toEqual([join(tmpRoot, 'seal.log')]);
    expect(fs.ensureDirCalls).toEqual([tmpRoot]);
  });

  test('subsequent appends do NOT re-invoke onCreate', () => {
    const fs = makeFakeFs();
    const onCreateCalls: string[] = [];
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      onCreate: (p) => onCreateCalls.push(p),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    sealer.append({ seq: 1, ts: 1000, hash: 'sha256:abc' });
    sealer.append({ seq: 100, ts: 2000, hash: 'sha256:def' });
    sealer.append({ seq: 200, ts: 3000, hash: 'sha256:ghi' });
    expect(onCreateCalls).toHaveLength(1);
    expect(fs.appendCalls).toHaveLength(3);
    expect(fs.ensureDirCalls).toHaveLength(1); // dir created once
  });

  test('onCreate throw → ok:false but the line is ALREADY persisted', () => {
    // Critical contract: the line MUST land on disk even when
    // chattr fails. Operators investigating a "could not seal"
    // alarm need to see what the engine TRIED to seal.
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      onCreate: () => {
        throw new Error('chattr +a failed: permission denied');
      },
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    const r = sealer.append({ seq: 1, ts: 1000, hash: 'sha256:abc' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toContain('chattr +a failed');
    // Data integrity invariant: the line landed.
    expect(fs.contents.get(join(tmpRoot, 'seal.log'))).toBe('seq=1\tts=1000\thash=sha256:abc\n');
  });

  test('invalid entry → ok:false, no disk write', () => {
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    const bad: SealEntry[] = [
      { seq: 0, ts: 1, hash: 'abc' }, // seq < 1
      { seq: 1, ts: -1, hash: 'abc' }, // ts negative
      { seq: 1, ts: 1, hash: '' }, // empty hash
      { seq: 1, ts: 1, hash: 'abc def' }, // whitespace breaks parsing
      { seq: 1, ts: 1, hash: 'abc\ttab' }, // tab inside hash
      { seq: 1.5, ts: 1, hash: 'abc' }, // non-integer seq
    ];
    for (const entry of bad) {
      const r = sealer.append(entry);
      expect(r.ok).toBe(false);
    }
    expect(fs.appendCalls).toHaveLength(0);
  });

  test('append fs failure → ok:false with reason', () => {
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: () => false,
      read: () => '',
      append: () => {
        throw new Error('ENOSPC: no space left');
      },
      ensureDir: () => {},
    });
    const r = sealer.append({ seq: 1, ts: 1000, hash: 'sha256:abc' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toContain('ENOSPC');
  });

  test('ensureDir failure → ok:false, no append attempted', () => {
    let appendCalled = false;
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'nested', 'seal.log'),
      exists: () => false,
      read: () => '',
      append: () => {
        appendCalled = true;
      },
      ensureDir: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    const r = sealer.append({ seq: 1, ts: 1000, hash: 'sha256:abc' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toContain('ensureDir failed');
    expect(appendCalled).toBe(false);
  });
});

describe('createWormFileSealer — list', () => {
  test('empty / non-existent file → []', () => {
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    expect(sealer.list()).toEqual([]);
  });

  test('parses all appended entries in order', () => {
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    sealer.append({ seq: 1, ts: 1000, hash: 'sha256:aaa' });
    sealer.append({ seq: 100, ts: 2000, hash: 'sha256:bbb' });
    sealer.append({ seq: 200, ts: 3000, hash: 'sha256:ccc' });
    expect(sealer.list()).toEqual([
      { seq: 1, ts: 1000, hash: 'sha256:aaa' },
      { seq: 100, ts: 2000, hash: 'sha256:bbb' },
      { seq: 200, ts: 3000, hash: 'sha256:ccc' },
    ]);
  });

  test('malformed line → throws with line number', () => {
    // Tampering scenario: an adversary edits the file (assuming
    // they bypassed chattr); the parser MUST detect garbage.
    const fs = makeFakeFs();
    const path = join(tmpRoot, 'seal.log');
    fs.contents.set(path, 'seq=1\tts=1000\thash=sha256:aaa\nNOT A VALID LINE\n');
    const sealer = createWormFileSealer({
      path,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    expect(() => sealer.list()).toThrow(/malformed seal entry at line 2/);
  });

  test('trailing newline is tolerated (no phantom entry)', () => {
    const fs = makeFakeFs();
    const path = join(tmpRoot, 'seal.log');
    fs.contents.set(path, 'seq=1\tts=1000\thash=sha256:aaa\n');
    const sealer = createWormFileSealer({
      path,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    expect(sealer.list()).toEqual([{ seq: 1, ts: 1000, hash: 'sha256:aaa' }]);
  });
});

describe('verifySealAgainstChain — integrates with real audit DB', () => {
  // Build a real audit chain, capture each row's this_hash into the
  // sealer, then cross-verify. This is the production path.

  const setupChain = (rowCount: number) => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'seal-uuid-aaaa-bbbb',
    });
    const sink = createSqliteSink({ db, identity });
    const emitted: Array<{ seq: number; this_hash: string }> = [];
    for (let i = 0; i < rowCount; i++) {
      const row = sink.emit({
        session_id: `s${i}`,
        tool_name: 'bash',
        args: { i },
        decision: 'allow',
        policy_hash: 'sha256:p',
        reason_chain: [],
        ts: 100 + i,
      });
      emitted.push({ seq: row.seq, this_hash: row.this_hash });
    }
    return { db, identity, sink, emitted };
  };

  test('matching seal entries → ok with entriesChecked count', () => {
    const { db, identity, emitted } = setupChain(5);
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    // Seal every other row — simulates the scheduler's interval.
    for (let i = 0; i < emitted.length; i += 2) {
      const row = emitted[i];
      if (row === undefined) continue;
      sealer.append({ seq: row.seq, ts: 100 + i, hash: row.this_hash });
    }
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.entriesChecked).toBe(3);
  });

  test('seal references missing seq → ok:false with firstMismatchAt', () => {
    const { db, identity } = setupChain(2);
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    // Reference seq=999 which doesn't exist in the chain.
    sealer.append({ seq: 999, ts: 1000, hash: 'sha256:abc' });
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.firstMismatchAt).toBe(999);
      expect(v.reason).toContain('missing from approvals_log');
    }
  });

  test('hash mismatch → ok:false with firstMismatchAt and both hashes in reason', () => {
    const { db, identity, emitted } = setupChain(3);
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    // Seal the FIRST row with the correct hash, then the SECOND
    // with a deliberately-wrong hash — the verifier should stop at
    // seq=2 (first mismatch).
    const first = emitted[0];
    const second = emitted[1];
    if (first === undefined || second === undefined) throw new Error('setup');
    sealer.append({ seq: first.seq, ts: 100, hash: first.this_hash });
    sealer.append({ seq: second.seq, ts: 101, hash: 'sha256:tampered000000000000000000' });
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.firstMismatchAt).toBe(second.seq);
      expect(v.reason).toContain(second.this_hash);
      expect(v.reason).toContain('sha256:tampered');
    }
  });

  test('corrupted seal file → ok:false (caught at list)', () => {
    const { db, identity } = setupChain(1);
    const fs = makeFakeFs();
    const path = join(tmpRoot, 'seal.log');
    fs.contents.set(path, 'GARBAGE LINE WITH NO TABS\n');
    const sealer = createWormFileSealer({
      path,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('seal file corrupted');
  });

  test('empty seal file verifies as ok with entriesChecked=0', () => {
    const { db, identity } = setupChain(3);
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.entriesChecked).toBe(0);
  });

  // Slice 129 (R5 P1): a hostile or corrupted seal backend can
  // surface two entries with the SAME seq. Pre-slice the
  // verifier reported OK when the duplicate's hash also matched
  // the DB row — that's a replay-attack vector (inflate
  // entriesChecked to mask a gap). Refuse duplicates outright.
  test('duplicate seq in seal file → ok:false (slice 129 replay defense)', () => {
    const { db, identity, emitted } = setupChain(2);
    const first = emitted[0];
    if (first === undefined) throw new Error('setup');
    const fs = makeFakeFs();
    // Bypass createWormFileSealer's own dedup-on-write and place
    // duplicate entries directly into the underlying file. Wire
    // format (slice 63): `seq=N\tts=N\thash=...\n`.
    const path = join(tmpRoot, 'seal.log');
    fs.contents.set(
      path,
      `seq=${first.seq}\tts=100\thash=${first.this_hash}\n` +
        `seq=${first.seq}\tts=101\thash=${first.this_hash}\n`,
    );
    const sealer = createWormFileSealer({
      path,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.firstMismatchAt).toBe(first.seq);
      expect(v.reason).toMatch(/duplicate/);
    }
  });
});

describe('createWormFileSealer — close', () => {
  test('close is a no-op that does not throw', () => {
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    expect(() => sealer.close()).not.toThrow();
  });
});

describe('createGitAnchoredSealer — append (§7.3 slice 63)', () => {
  // Capture git invocations via the exec seam so unit tests don't
  // need a real repo. Same content map for fs so list() reflects
  // what append() wrote.
  const makeFakeGitFs = () => {
    const fs = makeFakeFs();
    const gitCalls: Array<{ cmd: string; args: readonly string[]; cwd: string }> = [];
    let gitFail: { atArg0: string; reason: string } | null = null;
    const exec = (cmd: string, args: readonly string[], opts: { cwd: string }) => {
      gitCalls.push({ cmd, args, cwd: opts.cwd });
      if (gitFail !== null && args[0] === gitFail.atArg0) {
        throw new Error(gitFail.reason);
      }
    };
    return {
      ...fs,
      exec,
      gitCalls,
      failGitAt: (subcommand: string, reason: string) => {
        gitFail = { atArg0: subcommand, reason };
      },
    };
  };

  test('append writes entry line + runs git add + commit', () => {
    const fs = makeFakeGitFs();
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      exec: fs.exec,
    });
    const r = sealer.append({ seq: 1, ts: 1000, hash: 'sha256:abc' });
    expect(r).toEqual({ ok: true });
    // Line landed in seal.log.
    expect(fs.contents.get(join(tmpRoot, 'seal.log'))).toBe('seq=1\tts=1000\thash=sha256:abc\n');
    // git add seal.log + git commit -m "seal: seq=1 hash=sha256:abc"
    expect(fs.gitCalls).toHaveLength(2);
    expect(fs.gitCalls[0]?.cmd).toBe('git');
    expect(fs.gitCalls[0]?.args).toEqual(['add', 'seal.log']);
    expect(fs.gitCalls[0]?.cwd).toBe(tmpRoot);
    expect(fs.gitCalls[1]?.cmd).toBe('git');
    expect(fs.gitCalls[1]?.args).toEqual(['commit', '-m', 'seal: seq=1 hash=sha256:abc']);
  });

  test('custom sealFile name flows through to git add', () => {
    const fs = makeFakeGitFs();
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      sealFile: 'audit.log',
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      exec: fs.exec,
    });
    sealer.append({ seq: 2, ts: 2000, hash: 'sha256:def' });
    expect(fs.gitCalls[0]?.args).toEqual(['add', 'audit.log']);
    expect(fs.contents.get(join(tmpRoot, 'audit.log'))).toBeDefined();
  });

  test('invalid entry → ok:false, no disk write, no git invocation', () => {
    const fs = makeFakeGitFs();
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      exec: fs.exec,
    });
    const r = sealer.append({ seq: 0, ts: 1, hash: 'sha256:abc' });
    expect(r.ok).toBe(false);
    expect(fs.appendCalls).toHaveLength(0);
    expect(fs.gitCalls).toHaveLength(0);
  });

  test('append fs failure → ok:false, no git invocation', () => {
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      exists: () => false,
      read: () => '',
      append: () => {
        throw new Error('ENOSPC: no space left');
      },
      exec: () => {
        throw new Error('should not be called');
      },
    });
    const r = sealer.append({ seq: 1, ts: 1000, hash: 'sha256:abc' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toContain('ENOSPC');
  });

  test('git add failure → ok:false with reason; commit not attempted', () => {
    const fs = makeFakeGitFs();
    fs.failGitAt('add', 'fatal: not a git repository');
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      exec: fs.exec,
    });
    const r = sealer.append({ seq: 1, ts: 1000, hash: 'sha256:abc' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toContain('git add failed');
    expect((r as { ok: false; reason: string }).reason).toContain('not a git repository');
    // Only one git call happened (add); commit was skipped.
    expect(fs.gitCalls).toHaveLength(1);
    expect(fs.gitCalls[0]?.args[0]).toBe('add');
  });

  test('git commit failure → ok:false with reason', () => {
    const fs = makeFakeGitFs();
    fs.failGitAt('commit', 'nothing to commit, working tree clean');
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      exec: fs.exec,
    });
    const r = sealer.append({ seq: 1, ts: 1000, hash: 'sha256:abc' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toContain('git commit failed');
  });
});

describe('createGitAnchoredSealer — list', () => {
  test('parses appended entries back in order', () => {
    const fs = makeFakeFs();
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      exec: () => {}, // no-op git
    });
    sealer.append({ seq: 1, ts: 100, hash: 'sha256:aaa' });
    sealer.append({ seq: 2, ts: 200, hash: 'sha256:bbb' });
    expect(sealer.list()).toEqual([
      { seq: 1, ts: 100, hash: 'sha256:aaa' },
      { seq: 2, ts: 200, hash: 'sha256:bbb' },
    ]);
  });

  test('empty / non-existent repo seal file → []', () => {
    const fs = makeFakeFs();
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      exec: () => {},
    });
    expect(sealer.list()).toEqual([]);
  });

  test('malformed line → throws with line number (tampering signal)', () => {
    const fs = makeFakeFs();
    const path = join(tmpRoot, 'seal.log');
    fs.contents.set(path, 'seq=1\tts=100\thash=sha256:aaa\nGARBAGE\n');
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      exec: () => {},
    });
    expect(() => sealer.list()).toThrow(/malformed seal entry at line 2/);
  });
});

describe('defaultGitAnchoredFactory + factoryForSealMode', () => {
  test('defaultGitAnchoredFactory throws when config.path is missing', () => {
    expect(() => defaultGitAnchoredFactory({ mode: 'git-anchored' })).toThrow(
      'config.path is required',
    );
  });

  test('defaultGitAnchoredFactory builds a SealStore using config.path as repoPath', () => {
    // We can't easily assert "uses config.path as repoPath" without
    // exposing internals; instead, verify the factory returns the
    // expected SealStore shape (append + list + close present).
    const store = defaultGitAnchoredFactory({ mode: 'git-anchored', path: '/tmp/no-such-repo' });
    expect(typeof store.append).toBe('function');
    expect(typeof store.list).toBe('function');
    expect(typeof store.close).toBe('function');
  });

  test('factoryForSealMode dispatches by mode', () => {
    expect(factoryForSealMode('worm-file')).toBe(defaultWormFileFactory);
    expect(factoryForSealMode('git-anchored')).toBe(defaultGitAnchoredFactory);
    expect(factoryForSealMode('none')).toBeNull();
  });
});

describe('verifySealAgainstChain — works with git-anchored backend too', () => {
  // verifySealAgainstChain reads via store.list() — the backend
  // doesn't matter as long as the wire format is preserved. Pin
  // that contract here: a git-anchored sealer + a chain produced
  // by createSqliteSink cross-verify cleanly.
  test('git-anchored seal entries verify against the chain', async () => {
    const { createSqliteSink, ensureInstallId } = await import('../../src/permissions/index.ts');
    const { MIGRATIONS, migrate, openMemoryDb } = await import('../../src/storage/index.ts');
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'git-uuid-aaaa-bbbb',
    });
    const sink = createSqliteSink({ db, identity });
    const rows: Array<{ seq: number; this_hash: string }> = [];
    for (let i = 0; i < 3; i++) {
      const row = sink.emit({
        session_id: `s${i}`,
        tool_name: 'bash',
        args: { i },
        decision: 'allow',
        policy_hash: 'sha256:p',
        reason_chain: [],
        ts: 100 + i,
      });
      rows.push({ seq: row.seq, this_hash: row.this_hash });
    }
    const fs = makeFakeFs();
    const sealer = createGitAnchoredSealer({
      repoPath: tmpRoot,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      exec: () => {}, // skip git work; we're testing the wire format
    });
    for (const r of rows) {
      sealer.append({ seq: r.seq, ts: 100 + r.seq, hash: r.this_hash });
    }
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.entriesChecked).toBe(3);
  });
});
