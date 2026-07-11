import { describe, expect, test } from 'bun:test';
import { buildToolDefs } from '../../src/harness/loop.ts';
import type { HarnessConfig } from '../../src/harness/types.ts';

// buildToolDefs only reads name / description / inputSchema /
// metadata.requiresOperatorConfirm, so a minimal stub suffices.
const stub = (name: string, requiresOperatorConfirm: boolean) => ({
  name,
  description: `${name} desc`,
  inputSchema: { type: 'object', properties: {} },
  metadata: { category: 'misc', writes: false, idempotent: true, requiresOperatorConfirm },
  execute: async () => ({}),
});

const config = (operatorPresent: boolean): HarnessConfig =>
  ({
    toolRegistry: { list: () => [stub('read_file', false), stub('clarify', true)] },
    // confirmPermission is the marker of an interactive operator session;
    // the REPL wires it, headless run.ts leaves it unset.
    ...(operatorPresent ? { confirmPermission: async () => true } : {}),
  }) as unknown as HarnessConfig;

describe('buildToolDefs: requiresOperatorConfirm tools need an operator surface', () => {
  test('headless (no confirmPermission) hides them from the model', () => {
    // clarify would only return clarify.modal_unavailable here — don't
    // offer it (and don't let the "Ask, don't presume" bullet nudge the
    // model toward a tool it can't use).
    expect(buildToolDefs(config(false)).map((d) => d.name)).toEqual(['read_file']);
  });

  test('interactive (confirmPermission wired) exposes them', () => {
    expect(buildToolDefs(config(true)).map((d) => d.name)).toEqual(['read_file', 'clarify']);
  });
});

describe('buildToolDefs: reminder family needs a session-scoped scheduler', () => {
  const reminderStub = (name: string) => ({
    name,
    description: `${name} desc`,
    inputSchema: { type: 'object', properties: {} },
    metadata: {
      category: 'misc',
      writes: false,
      idempotent: false,
      requiresReminderScheduler: true,
    },
    execute: async () => ({}),
  });
  const cfg = (hasScheduler: boolean): HarnessConfig =>
    ({
      toolRegistry: { list: () => [stub('read_file', false), reminderStub('reminder')] },
      confirmPermission: async () => true, // operator present — isolate the scheduler axis
      ...(hasScheduler ? { reminderScheduler: {} } : {}),
    }) as unknown as HarnessConfig;

  test('no scheduler (one-shot / subagent) hides the reminder tools', () => {
    expect(buildToolDefs(cfg(false)).map((d) => d.name)).toEqual(['read_file']);
  });

  test('scheduler present (REPL) exposes them', () => {
    expect(buildToolDefs(cfg(true)).map((d) => d.name)).toEqual(['read_file', 'reminder']);
  });
});
