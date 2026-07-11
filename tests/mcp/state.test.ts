import { describe, expect, test } from 'bun:test';
import {
  canMcpTransition,
  isMcpTerminal,
  MCP_SERVER_STATES,
  mcpTransition,
} from '../../src/mcp/state.ts';

describe('mcpTransition: canonical §6.5 edges', () => {
  test('fresh-trust path', () => {
    expect(mcpTransition('disconnected', 'handshaking')).toBe('handshaking');
    expect(mcpTransition('handshaking', 'trust_pending')).toBe('trust_pending');
    expect(mcpTransition('trust_pending', 'trusted')).toBe('trusted');
    expect(mcpTransition('trust_pending', 'denied')).toBe('denied');
    expect(mcpTransition('handshaking', 'error')).toBe('error');
  });

  test('degraded ⇄ active recover loop', () => {
    expect(mcpTransition('active', 'degraded')).toBe('degraded');
    expect(mcpTransition('degraded', 'active')).toBe('active');
  });
});

describe('mcpTransition: manager-specific edges (the superset the impl needs)', () => {
  test('cache-restore, lazy reconnect, fail-closed deny, drift, transport blip', () => {
    expect(mcpTransition('disconnected', 'trusted')).toBe('trusted'); // cache restore
    expect(mcpTransition('disconnected', 'denied')).toBe('denied'); // fail-closed deny
    expect(mcpTransition('trusted', 'handshaking')).toBe('handshaking'); // lazy reconnect
    expect(mcpTransition('handshaking', 'active')).toBe('active'); // reconnect ok
    expect(mcpTransition('handshaking', 'degraded')).toBe('degraded'); // drift
    expect(mcpTransition('active', 'disconnected')).toBe('disconnected'); // transport blip
  });

  test('a self-transition is idempotent (never throws)', () => {
    expect(mcpTransition('active', 'active')).toBe('active');
  });
});

describe('mcpTransition: invalid edges throw', () => {
  test('cannot jump disconnected → active', () => {
    expect(() => mcpTransition('disconnected', 'active')).toThrow(/invalid transition/);
  });

  test('terminal states have no exits', () => {
    expect(() => mcpTransition('denied', 'trusted')).toThrow();
    expect(() => mcpTransition('error', 'handshaking')).toThrow();
  });
});

describe('→ denied reachable from every non-terminal state (revoke + fail-closed)', () => {
  test('every non-terminal → denied', () => {
    for (const s of MCP_SERVER_STATES) {
      if (isMcpTerminal(s)) continue;
      expect(canMcpTransition(s, 'denied')).toBe(true);
    }
  });
});

describe('helpers', () => {
  test('canMcpTransition mirrors validity without throwing', () => {
    expect(canMcpTransition('disconnected', 'handshaking')).toBe(true);
    expect(canMcpTransition('disconnected', 'active')).toBe(false);
  });

  test('isMcpTerminal flags only denied + error', () => {
    expect(isMcpTerminal('denied')).toBe(true);
    expect(isMcpTerminal('error')).toBe(true);
    expect(isMcpTerminal('active')).toBe(false);
    expect(isMcpTerminal('disconnected')).toBe(false);
  });

  test('there are exactly 8 states', () => {
    expect(MCP_SERVER_STATES).toHaveLength(8);
  });
});
