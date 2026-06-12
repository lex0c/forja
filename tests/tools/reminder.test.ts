import { describe, expect, test } from 'bun:test';
import { type ReminderScheduler, createReminderScheduler } from '../../src/reminders/index.ts';
import { reminderCancelTool } from '../../src/tools/builtin/reminder-cancel.ts';
import { reminderListTool } from '../../src/tools/builtin/reminder-list.ts';
import { reminderTool } from '../../src/tools/builtin/reminder.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

// Real scheduler with default (live) timers — the tool tests assert the
// wiring/validation, not the firing (that's covered deterministically in
// tests/reminders/scheduler.test.ts).
const sched = (): ReminderScheduler => createReminderScheduler({ onFire: () => {} });

describe('reminder tool', () => {
  test('schedules and returns an id + fire_at', async () => {
    const ctx = makeCtx({ reminderScheduler: sched() });
    const r = await reminderTool.execute({ in: '10m', note: 'check deploy' }, ctx);
    if (isToolError(r)) throw new Error(`unexpected: ${r.error_message}`);
    expect(typeof r.reminder_id).toBe('string');
    expect(r.fire_at).toBeGreaterThan(0);
  });

  test('rejects a malformed delay', async () => {
    const ctx = makeCtx({ reminderScheduler: sched() });
    const r = await reminderTool.execute({ in: 'soon', note: 'x' }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('relative delay');
  });

  test('rejects an empty note', async () => {
    const ctx = makeCtx({ reminderScheduler: sched() });
    const r = await reminderTool.execute({ in: '5m', note: '' }, ctx);
    expect(isToolError(r)).toBe(true);
  });

  test('rejects a delay beyond the horizon cap as invalid_arg (not a crash)', async () => {
    const ctx = makeCtx({ reminderScheduler: sched() });
    const r = await reminderTool.execute({ in: '48h', note: 'too far' }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('tool.invalid_arg');
    expect(r.error_message).toContain('horizon cap');
  });

  test('clean error when no scheduler (e.g. one-shot run)', async () => {
    const ctx = makeCtx({}); // no reminderScheduler
    const r = await reminderTool.execute({ in: '5m', note: 'x' }, ctx);
    if (!isToolError(r)) throw new Error('expected error');
    expect(r.error_code).toBe('reminder.scheduler_unavailable');
  });
});

describe('reminder_list / reminder_cancel tools', () => {
  test('list reflects scheduled reminders and cancel removes one', async () => {
    const scheduler = sched();
    const ctx = makeCtx({ reminderScheduler: scheduler });
    const set = await reminderTool.execute({ in: '30m', note: 'later' }, ctx);
    if (isToolError(set)) throw new Error('schedule failed');

    const listed = await reminderListTool.execute({}, ctx);
    if (isToolError(listed)) throw new Error('list failed');
    expect(listed.total).toBe(1);
    expect(listed.reminders[0]?.reminder_id).toBe(set.reminder_id);
    expect(listed.reminders[0]?.note).toBe('later');

    const cancelled = await reminderCancelTool.execute({ reminder_id: set.reminder_id }, ctx);
    if (isToolError(cancelled)) throw new Error('cancel failed');
    expect(cancelled.cancelled).toBe(true);

    const after = await reminderListTool.execute({}, ctx);
    if (isToolError(after)) throw new Error('list failed');
    expect(after.total).toBe(0);
  });

  test('cancel of an unknown id is idempotent (cancelled: false, not an error)', async () => {
    const ctx = makeCtx({ reminderScheduler: sched() });
    const r = await reminderCancelTool.execute({ reminder_id: 'nope' }, ctx);
    if (isToolError(r)) throw new Error('should not error');
    expect(r.cancelled).toBe(false);
  });
});
