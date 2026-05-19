// node-ids parser tests (RETRIEVAL.md §8.1).
//
// Shared parsers used by both `compression.ts` (defense against
// corrupt trace replays) and `views/session.ts` (M8 review: drop
// silent slice-to-empty when BM25 emits a malformed id). The
// invariants must hold uniformly across both call sites — these
// tests pin the contract.

import { describe, expect, test } from 'bun:test';
import { parseMemoryNodeId, parseSessionNodeId } from '../../src/retrieval/node-ids.ts';

describe('parseMemoryNodeId', () => {
  test('accepts canonical shape with each MemoryScope', () => {
    expect(parseMemoryNodeId('memory:user/role')).toEqual({ scope: 'user', name: 'role' });
    expect(parseMemoryNodeId('memory:project_shared/auth')).toEqual({
      scope: 'project_shared',
      name: 'auth',
    });
    expect(parseMemoryNodeId('memory:project_local/notes')).toEqual({
      scope: 'project_local',
      name: 'notes',
    });
  });

  test('rejects names containing `/` (scope must be a canonical enum, not a path)', () => {
    // The parser splits on `lastIndexOf('/')` and then validates
    // the prefix against the MemoryScope enum. So
    // `memory:user/path/to/note` parses as scope='user/path/to'
    // (not in the enum) → null. Memory names with slashes are
    // not supported by this format; if a future memory name
    // shape allows them, the parser needs an explicit indexOf
    // split + enum check instead.
    expect(parseMemoryNodeId('memory:user/path/to/note')).toBeNull();
  });

  test('rejects missing prefix', () => {
    expect(parseMemoryNodeId('user/role')).toBeNull();
    expect(parseMemoryNodeId('session:message:abc')).toBeNull();
  });

  test('rejects missing slash', () => {
    expect(parseMemoryNodeId('memory:user-role')).toBeNull();
  });

  test('rejects empty scope or name', () => {
    expect(parseMemoryNodeId('memory:/role')).toBeNull();
    expect(parseMemoryNodeId('memory:user/')).toBeNull();
    expect(parseMemoryNodeId('memory:/')).toBeNull();
  });

  test('rejects unknown scope (corrupt trace replay defense)', () => {
    expect(parseMemoryNodeId('memory:made_up_scope/role')).toBeNull();
    expect(parseMemoryNodeId('memory:User/role')).toBeNull(); // case-sensitive
  });
});

describe('parseSessionNodeId', () => {
  test('accepts each canonical kind', () => {
    expect(parseSessionNodeId('session:message:msg-1')).toEqual({
      kind: 'message',
      id: 'msg-1',
    });
    expect(parseSessionNodeId('session:tool_call:tc-2')).toEqual({
      kind: 'tool_call',
      id: 'tc-2',
    });
    expect(parseSessionNodeId('session:failure:fail-3')).toEqual({
      kind: 'failure',
      id: 'fail-3',
    });
  });

  test('preserves UUIDs (most common id shape)', () => {
    expect(parseSessionNodeId('session:message:1d56b6e1-13c1-43e1-99c9-2f5f3b1f8b1f')).toEqual({
      kind: 'message',
      id: '1d56b6e1-13c1-43e1-99c9-2f5f3b1f8b1f',
    });
  });

  test('rejects missing prefix', () => {
    expect(parseSessionNodeId('message:abc')).toBeNull();
    expect(parseSessionNodeId('memory:user/role')).toBeNull();
  });

  test('rejects empty kind or id (M8 regression — used to slice to empty silently)', () => {
    // Pre-M8, session view did `hit.id.slice('session:message:'.length)`
    // and `.get('')` returned undefined silently. The parser now
    // refuses both shapes.
    expect(parseSessionNodeId('session:message:')).toBeNull();
    expect(parseSessionNodeId('session::msg-1')).toBeNull();
    expect(parseSessionNodeId('session:')).toBeNull();
  });

  test('rejects unknown kind', () => {
    expect(parseSessionNodeId('session:unknown:abc')).toBeNull();
    expect(parseSessionNodeId('session:Message:abc')).toBeNull(); // case-sensitive
  });

  test('id can contain colons (UUIDs do not, but failure codes might)', () => {
    // The parser splits on the FIRST `:` after `session:`, so any
    // colons in the id pass through. Future failure codes like
    // `auth:token_expired` round-trip correctly.
    expect(parseSessionNodeId('session:failure:auth:token_expired')).toEqual({
      kind: 'failure',
      id: 'auth:token_expired',
    });
  });
});
