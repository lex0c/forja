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

  // Slice 134 P0-2: pin the cross-install forgery defense
  // (slice 128 R4 P0-Audit-1). Pre-slice 128, `verifySealAgainstChain`
  // called `getApprovalsLogBySeq(db, entry.seq)` without install_id
  // filtering — an attacker with DB-write could insert a row for
  // install B with a controlled hash, then edit the seal file for
  // install A to reference that row → verify succeeds against
  // install B's row, install A's actual chain unprotected.
  // Slice 128 added the required install_id parameter; without a
  // test pinning the refuse path, a refactor dropping the param
  // ships green.
  test('seal references row from different install_id → ok:false (cross-install forgery)', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    // Seed TWO installs on the same DB. Each sink chains
    // independently under its own install_id.
    const identityA = { install_id: 'install-a', created_at_ms: 1 };
    const identityB = { install_id: 'install-b', created_at_ms: 2 };
    const sinkA = createSqliteSink({ db, identity: identityA });
    const sinkB = createSqliteSink({ db, identity: identityB });
    const rowA = sinkA.emit({
      session_id: 'sa',
      tool_name: 'bash',
      args: { x: 'a' },
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      ts: 100,
    });
    const rowB = sinkB.emit({
      session_id: 'sb',
      tool_name: 'bash',
      args: { x: 'b' },
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      ts: 200,
    });
    // Seal references row from install B (a hostile seal store
    // pointing at the wrong install's row).
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    sealer.append({ seq: rowB.seq, ts: 200, hash: rowB.this_hash });
    // Verify with install A's identity — must refuse.
    const v = verifySealAgainstChain(sealer, db, identityA.install_id);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.firstMismatchAt).toBe(rowB.seq);
      expect(v.reason).toMatch(/install_id|cross-install/);
    }
    // Sanity: verify with install B's identity passes for the
    // same seal entry — the binding is identity-scoped, not
    // global.
    const vOk = verifySealAgainstChain(sealer, db, identityB.install_id);
    expect(vOk.ok).toBe(true);
    // Sanity: rowA exists but is not in the seal — irrelevant
    // to this verify call.
    void rowA;
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

// Slice 135 P0-5: parametric missing-seq + hash-mismatch verify
// matrix across ALL 4 backends. verifySealAgainstChain operates
// purely through `store.list()` so the backend should not matter,
// but each sealer parses its own seal.log lines and a future
// regression in one parser (e.g., S3's parseLine forgetting to
// validate seq monotonicity) could silently let bad entries pass
// the verifier. This block locks that contract in place.
//
// The matrix runs each backend through three scenarios:
//   - missing-seq: append seq=999 to the seal store, chain has
//     no row at seq=999 → verify fails with "missing from
//     approvals_log";
//   - hash-mismatch: append a seq that IS in the chain but with a
//     tampered hash → verify fails with "hash mismatch at seq=N";
//   - happy path: append the correct seq + hash → verify ok.
describe('verifySealAgainstChain — parametric matrix across all 4 backends (slice 135 P0-5)', () => {
  // Common audit-chain fixture; per-test stores are built by the
  // backend factory inside each test.
  const buildChain = (rowCount: number) => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'param-uuid-aaaa-bbbb',
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
    return { db, identity, emitted };
  };

  // Each backend factory returns a `SealStore` constructed with the
  // in-memory fs seam so all four are uniform from the test's POV.
  // The matrix is driven by an explicit array (not test.each) to
  // keep the boilerplate readable and grep-friendly.
  type BackendFactory = (
    fs: FakeFs,
    dir: string,
  ) => {
    store: ReturnType<typeof createWormFileSealer>;
  };

  const BACKENDS: Array<{ name: string; build: BackendFactory }> = [
    {
      name: 'worm-file',
      build: (fs, dir) => ({
        store: createWormFileSealer({
          path: join(dir, 'seal.log'),
          exists: fs.exists,
          read: fs.read,
          append: fs.append,
          ensureDir: fs.ensureDir,
        }),
      }),
    },
    {
      name: 'git-anchored',
      build: (fs, dir) => ({
        store: createGitAnchoredSealer({
          repoPath: dir,
          exists: fs.exists,
          read: fs.read,
          append: fs.append,
          exec: () => {}, // skip real git; we only exercise the wire format
        }),
      }),
    },
  ];

  // Lazy-import the TSA + S3 sealers so the static imports up top
  // stay minimal. Done synchronously inside each test via require.
  const buildRfc3161 = (fs: FakeFs, dir: string) => {
    type Rfc3161Module = typeof import('../../src/permissions/sealing-rfc3161.ts');
    const { createRfc3161TsaSealer } =
      require('../../src/permissions/sealing-rfc3161.ts') as Rfc3161Module;
    return createRfc3161TsaSealer({
      path: dir,
      endpoint: 'https://tsa.example.com',
      // Scripted submitter — return a deterministic TSR for any
      // input. The verifier never reads .tsr files so we don't care
      // about the bytes.
      submit: () => ({ ok: true, tsr: new Uint8Array([0x00]) }),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      // The TSR write goes to disk; we direct it to the fake fs too
      // so the test doesn't pollute /tmp with stray .tsr files.
      writeBinary: () => {},
      ensureDir: fs.ensureDir,
    });
  };

  const buildS3 = (fs: FakeFs, dir: string) => {
    type S3Module = typeof import('../../src/permissions/sealing-s3-object-lock.ts');
    const { createS3ObjectLockSealer } =
      require('../../src/permissions/sealing-s3-object-lock.ts') as S3Module;
    return createS3ObjectLockSealer({
      path: dir,
      bucket: 'forja-seals',
      retentionDays: 1,
      submit: () => ({ ok: true }),
      now: () => 0,
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
  };

  const ALL_BACKENDS: Array<{
    name: string;
    build: (fs: FakeFs, dir: string) => ReturnType<typeof createWormFileSealer>;
  }> = [
    ...BACKENDS.map((b) => ({
      name: b.name,
      build: (fs: FakeFs, dir: string) => b.build(fs, dir).store,
    })),
    { name: 'rfc3161-tsa', build: buildRfc3161 },
    { name: 's3-object-lock', build: buildS3 },
  ];

  for (const backend of ALL_BACKENDS) {
    test(`[${backend.name}] happy path: matching entries → ok with entriesChecked`, () => {
      const fs = makeFakeFs();
      const { db, identity, emitted } = buildChain(3);
      const store = backend.build(fs, tmpRoot);
      for (let i = 0; i < emitted.length; i++) {
        const row = emitted[i];
        if (row === undefined) continue;
        const r = store.append({ seq: row.seq, ts: 1000 + i, hash: row.this_hash });
        expect(r.ok).toBe(true);
      }
      const v = verifySealAgainstChain(store, db, identity.install_id);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.entriesChecked).toBe(3);
    });

    test(`[${backend.name}] missing-seq: seal references seq=999 not in chain → ok:false`, () => {
      const fs = makeFakeFs();
      const { db, identity } = buildChain(2);
      const store = backend.build(fs, tmpRoot);
      // Append a real entry first (seq=1) so the verifier has at
      // least one valid row to walk past — proves the failure
      // emerges on the missing seq, not on the first lookup.
      const emitted = buildChain(2).emitted; // discard new db; just need a valid hash
      // Actually we already have the original chain's emitted — re-fetch:
      const real = db
        .query('SELECT seq, this_hash FROM approvals_log WHERE install_id = ? ORDER BY seq ASC')
        .all(identity.install_id) as Array<{ seq: number; this_hash: string }>;
      expect(real.length).toBe(2);
      const first = real[0];
      if (first === undefined) throw new Error('setup');
      const r1 = store.append({ seq: first.seq, ts: 100, hash: first.this_hash });
      expect(r1.ok).toBe(true);
      // Now plant the bogus entry. Use a SHA-256-shaped hash to
      // satisfy the rfc3161 backend's append-time validator (the
      // worm/git/s3 backends accept any non-empty hash string).
      const fakeHash = 'a'.repeat(64);
      const r2 = store.append({ seq: 999, ts: 200, hash: fakeHash });
      expect(r2.ok).toBe(true);
      const v = verifySealAgainstChain(store, db, identity.install_id);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.firstMismatchAt).toBe(999);
        expect(v.reason).toContain('missing from approvals_log');
      }
      // Silence unused-var lint — `emitted` was kept for symmetry
      // with other parametric scenarios.
      expect(emitted.length).toBeGreaterThan(0);
    });

    test(`[${backend.name}] hash-mismatch: seal hash for valid seq doesn't match chain → ok:false`, () => {
      const fs = makeFakeFs();
      const { db, identity, emitted } = buildChain(2);
      const store = backend.build(fs, tmpRoot);
      const first = emitted[0];
      const second = emitted[1];
      if (first === undefined || second === undefined) throw new Error('setup');
      // First entry: correct hash → walks past.
      store.append({ seq: first.seq, ts: 100, hash: first.this_hash });
      // Second entry: tampered hash (still 64-hex-char so rfc3161
      // accepts the append; the verifier MUST reject it on the
      // db cross-check).
      const tamperedHash = 'b'.repeat(64);
      store.append({ seq: second.seq, ts: 101, hash: tamperedHash });
      const v = verifySealAgainstChain(store, db, identity.install_id);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.firstMismatchAt).toBe(second.seq);
        expect(v.reason).toContain('hash mismatch at seq=');
        expect(v.reason).toContain(tamperedHash);
        expect(v.reason).toContain(second.this_hash);
      }
    });
  }
});

// Slice 135 P1 audit-4: rotation + unsealed entries. The rotate-chain
// flow moves approvals_log rows into approvals_log_archived; the
// seal store is NOT touched by rotation. If the scheduler hadn't
// caught up to the chain tip before the operator rotated, the seal
// entries now point at seqs that are no longer in approvals_log
// — verifySealAgainstChain will fail with "missing from
// approvals_log". This is the canonical "rotate without
// sealing-first" gap; the test pins the observable failure mode
// so an operator running `agent permission seal-verify` after a
// rotation sees a clear diagnostic instead of a silent pass.
describe('verifySealAgainstChain — rotation + unsealed entries (slice 135 P1 audit-4)', () => {
  test('rotation orphans pre-rotation seal entries — verify reports missing seq', async () => {
    const { rotateChain } = await import('../../src/storage/repos/chain-rotation.ts');
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'rot-uuid-aaaa-bbbb',
    });
    const sink = createSqliteSink({ db, identity });
    // Emit 3 rows, seal the latest (seq=3) BEFORE rotation.
    const rows: Array<{ seq: number; this_hash: string }> = [];
    for (let i = 0; i < 3; i++) {
      rows.push(
        sink.emit({
          session_id: `s${i}`,
          tool_name: 'bash',
          args: { i },
          decision: 'allow',
          policy_hash: 'sha256:p',
          reason_chain: [],
          ts: 100 + i,
        }),
      );
    }
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    const seq3 = rows[2];
    if (seq3 === undefined) throw new Error('setup');
    sealer.append({ seq: seq3.seq, ts: 200, hash: seq3.this_hash });
    // Pre-rotation: verify clean.
    const before = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(before.ok).toBe(true);

    // Operator rotates without first sealing the new tip. The
    // existing seal entry still points at the pre-rotation seq=3,
    // which is now in approvals_log_archived only.
    rotateChain(db, {
      install_id: identity.install_id,
      reason: 'planned-rotation',
      rotated_at_ms: 500,
    });
    const after = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.firstMismatchAt).toBe(seq3.seq);
      expect(after.reason).toContain('missing from approvals_log');
    }
  });

  test('post-rotation: a freshly emitted + sealed row verifies cleanly (no cross-contamination)', async () => {
    const { rotateChain } = await import('../../src/storage/repos/chain-rotation.ts');
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'rot-fresh-uuid',
    });
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    // Pre-rotation chain (no seals yet).
    const sinkPre = createSqliteSink({ db, identity });
    sinkPre.emit({
      session_id: 's-pre',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      ts: 100,
    });
    rotateChain(db, {
      install_id: identity.install_id,
      reason: 'r',
      rotated_at_ms: 200,
    });
    // Post-rotation chain: emit + seal one row.
    const sinkPost = createSqliteSink({ db, identity });
    const post = sinkPost.emit({
      session_id: 's-post',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      ts: 300,
    });
    sealer.append({ seq: post.seq, ts: 400, hash: post.this_hash });
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.entriesChecked).toBe(1);
  });

  test('mixed seal store (some pre-rotation, some post-rotation) → verify fails at first orphan', async () => {
    const { rotateChain } = await import('../../src/storage/repos/chain-rotation.ts');
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'rot-mixed-uuid',
    });
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    // Pre-rotation: emit + seal.
    const sinkPre = createSqliteSink({ db, identity });
    const pre = sinkPre.emit({
      session_id: 's-pre',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      ts: 100,
    });
    sealer.append({ seq: pre.seq, ts: 150, hash: pre.this_hash });
    rotateChain(db, {
      install_id: identity.install_id,
      reason: 'r',
      rotated_at_ms: 200,
    });
    // Post-rotation: emit + seal.
    const sinkPost = createSqliteSink({ db, identity });
    const post = sinkPost.emit({
      session_id: 's-post',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      ts: 300,
    });
    sealer.append({ seq: post.seq, ts: 400, hash: post.this_hash });

    // Seal store now has two entries: the pre-rotation seq (orphaned)
    // and the post-rotation seq (valid). Verify walks in store order
    // — fails at the FIRST orphan it hits.
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.firstMismatchAt).toBe(pre.seq);
      expect(v.reason).toContain('missing from approvals_log');
    }
  });
});
