import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import {
  type SealEntry,
  createWormFileSealer,
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
    const { db, emitted } = setupChain(5);
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
    const v = verifySealAgainstChain(sealer, db);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.entriesChecked).toBe(3);
  });

  test('seal references missing seq → ok:false with firstMismatchAt', () => {
    const { db } = setupChain(2);
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
    const v = verifySealAgainstChain(sealer, db);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.firstMismatchAt).toBe(999);
      expect(v.reason).toContain('missing from approvals_log');
    }
  });

  test('hash mismatch → ok:false with firstMismatchAt and both hashes in reason', () => {
    const { db, emitted } = setupChain(3);
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
    const v = verifySealAgainstChain(sealer, db);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.firstMismatchAt).toBe(second.seq);
      expect(v.reason).toContain(second.this_hash);
      expect(v.reason).toContain('sha256:tampered');
    }
  });

  test('corrupted seal file → ok:false (caught at list)', () => {
    const { db } = setupChain(1);
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
    const v = verifySealAgainstChain(sealer, db);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('seal file corrupted');
  });

  test('empty seal file verifies as ok with entriesChecked=0', () => {
    const { db } = setupChain(3);
    const fs = makeFakeFs();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: fs.exists,
      read: fs.read,
      append: fs.append,
      ensureDir: fs.ensureDir,
    });
    const v = verifySealAgainstChain(sealer, db);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.entriesChecked).toBe(0);
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
