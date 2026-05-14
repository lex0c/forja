import { describe, expect, test } from 'bun:test';
import {
  BOOTSTRAP_SESSION_ID,
  CODE_VOCABULARY,
  FAILURE_CLASSES,
  isFailureCode,
  isFailureCodeFormat,
  isRecoveryAction,
} from '../../src/failures/codes.ts';

describe('isFailureCodeFormat', () => {
  test('accepts <class>.<subtype>', () => {
    expect(isFailureCodeFormat('sandbox.tool_unavailable')).toBe(true);
    expect(isFailureCodeFormat('storage.lock_contention')).toBe(true);
  });

  test('accepts <class>.<subtype>.<detail>', () => {
    expect(isFailureCodeFormat('provider.timeout.streaming')).toBe(true);
  });

  test('accepts up to 4-part depth', () => {
    expect(isFailureCodeFormat('mcp.tool.timeout.slow')).toBe(true);
  });

  test('rejects single-segment', () => {
    expect(isFailureCodeFormat('sandbox')).toBe(false);
  });

  test('rejects empty segments', () => {
    expect(isFailureCodeFormat('sandbox..tool')).toBe(false);
    expect(isFailureCodeFormat('.sandbox.tool')).toBe(false);
    expect(isFailureCodeFormat('sandbox.tool.')).toBe(false);
  });

  test('rejects uppercase', () => {
    expect(isFailureCodeFormat('Sandbox.Tool')).toBe(false);
    expect(isFailureCodeFormat('sandbox.TOOL')).toBe(false);
  });

  test('rejects non-allowed chars', () => {
    expect(isFailureCodeFormat('sandbox-tool')).toBe(false);
    expect(isFailureCodeFormat('sandbox/tool')).toBe(false);
    expect(isFailureCodeFormat('sandbox.tool 1')).toBe(false);
  });

  test('rejects too deep (5+ segments)', () => {
    expect(isFailureCodeFormat('a.b.c.d.e')).toBe(false);
  });
});

describe('isFailureCode (vocabulary)', () => {
  test('slice 130 codes are registered', () => {
    expect(isFailureCode('sandbox.tool_unavailable')).toBe(true);
    expect(isFailureCode('sandbox.mid_session_loss')).toBe(true);
    expect(isFailureCode('storage.lock_contention')).toBe(true);
    expect(isFailureCode('storage.persist_failed')).toBe(true);
  });

  test('format-valid but unregistered code is rejected', () => {
    // Reserved for future slices — emit must hard-fail until the
    // owning subsystem adds the entry.
    expect(isFailureCode('provider.timeout.streaming')).toBe(false);
    expect(isFailureCode('mcp.transport.broken')).toBe(false);
  });

  test('format-invalid code rejected', () => {
    expect(isFailureCode('Sandbox.Tool')).toBe(false);
  });
});

describe('CODE_VOCABULARY shape', () => {
  test('every registered code maps to a valid FailureClass', () => {
    for (const [_code, classe] of CODE_VOCABULARY) {
      expect(FAILURE_CLASSES.has(classe)).toBe(true);
    }
  });

  test('every registered code passes the format regex', () => {
    for (const code of CODE_VOCABULARY.keys()) {
      expect(isFailureCodeFormat(code)).toBe(true);
    }
  });
});

describe('isRecoveryAction', () => {
  test('accepts exact-set values', () => {
    expect(isRecoveryAction('fatal')).toBe(true);
    expect(isRecoveryAction('ignored')).toBe(true);
    expect(isRecoveryAction('degraded')).toBe(true);
    expect(isRecoveryAction('pending_repair')).toBe(true);
  });

  test('accepts retried_Nx pattern', () => {
    expect(isRecoveryAction('retried_3x')).toBe(true);
    expect(isRecoveryAction('retried_10x')).toBe(true);
  });

  test('accepts fallback_to_<name> pattern', () => {
    expect(isRecoveryAction('fallback_to_anthropic_haiku')).toBe(true);
    expect(isRecoveryAction('fallback_to_openai-gpt-4')).toBe(true);
  });

  test('rejects typos and unknown shapes', () => {
    expect(isRecoveryAction('fatla')).toBe(false);
    expect(isRecoveryAction('retired_3x')).toBe(false); // typo
    expect(isRecoveryAction('retried_x')).toBe(false); // missing digit
    expect(isRecoveryAction('fallback_to_')).toBe(false); // empty target
    expect(isRecoveryAction('')).toBe(false);
  });
});

describe('BOOTSTRAP_SESSION_ID', () => {
  test('stable literal', () => {
    // Pinned: any change breaks pre-session forensics queries
    // that filter on this sentinel. Must be intentional.
    expect(BOOTSTRAP_SESSION_ID).toBe('bootstrap');
  });
});
