// MCP server lifecycle (STATE_MACHINE §6.5), as a state→state transition
// table mirroring src/permissions/state-machine.ts. This is the model the
// manager's `setState` validates against: every edge the manager performs is
// declared here, and an undeclared transition throws — a manager bug
// surfacing loudly beats silently corrupting the persisted state.
//
// It is a faithful SUPERSET of the spec's canonical §6.5 lifecycle: it also
// admits the S1 manager's lazy-reconnect (trusted→handshaking→active),
// cache-restore (disconnected→trusted), fail-closed deny (disconnected→denied),
// and drift-degrade (handshaking→degraded) edges that the narrative §6.5
// diagram doesn't draw but the implementation needs.
//
//   disconnected → handshaking → trust_pending → trusted → active ⇄ degraded
//        │ ▲  ▲          │  │           │  │         ▲ │        │
//        ▼ │  └ trusted ◄┘  ▼           ▼  ▼         │ ▼        ▼
//     trusted │          active       error denied  └ (transport_error → disconnected)
//      (cache)│
//
// `denied` and `error` are terminal — no edges leave them (only operator
// re-config / re-trust, handled above this module). `isMcpTerminal` guards the
// call path before any transition is attempted.

import type { McpServerState } from './types.ts';

export const MCP_SERVER_STATES: readonly McpServerState[] = [
  'disconnected',
  'handshaking',
  'trust_pending',
  'trusted',
  'active',
  'degraded',
  'denied',
  'error',
];

// Valid edges. `denied`/`error` are sinks (empty sets). `→ denied` is allowed
// from every non-terminal state (operator `/mcp revoke` + the fail-closed
// deny); `→ disconnected` from the live states models a transport blip.
const TRANSITIONS: ReadonlyMap<McpServerState, ReadonlySet<McpServerState>> = new Map([
  ['disconnected', new Set<McpServerState>(['handshaking', 'trusted', 'denied'])],
  [
    'handshaking',
    new Set<McpServerState>([
      'trust_pending',
      'active',
      'degraded',
      'disconnected',
      'error',
      'denied',
    ]),
  ],
  ['trust_pending', new Set<McpServerState>(['trusted', 'denied', 'error'])],
  [
    'trusted',
    new Set<McpServerState>(['handshaking', 'active', 'disconnected', 'degraded', 'denied']),
  ],
  ['active', new Set<McpServerState>(['degraded', 'disconnected', 'denied'])],
  ['degraded', new Set<McpServerState>(['active', 'disconnected', 'denied'])],
  ['denied', new Set<McpServerState>([])],
  ['error', new Set<McpServerState>([])],
]);

// A self-transition (from === to) is always allowed (idempotent re-set).
export const canMcpTransition = (from: McpServerState, to: McpServerState): boolean =>
  from === to || (TRANSITIONS.get(from)?.has(to) ?? false);

// Validate an edge, returning the target state. Throws on an undeclared edge
// so a manager bug surfaces loudly instead of corrupting persisted state.
export const mcpTransition = (from: McpServerState, to: McpServerState): McpServerState => {
  if (!canMcpTransition(from, to)) {
    throw new Error(`mcp state-machine: invalid transition '${from}' → '${to}'`);
  }
  return to;
};

// Operator-exit states — a transport blip or lazy reconnect must not move out
// of these on its own.
export const isMcpTerminal = (state: McpServerState): boolean =>
  state === 'denied' || state === 'error';
