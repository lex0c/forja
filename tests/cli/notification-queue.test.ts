import { describe, expect, test } from 'bun:test';
import {
  formatNotification,
  formatNotificationHeadline,
  type NotificationPayload,
  NotificationQueue,
} from '../../src/cli/notification-queue.ts';

describe('formatNotificationHeadline', () => {
  test('bg_done: command, status, exit code, process id + bash_output pointer', () => {
    expect(
      formatNotificationHeadline({
        kind: 'bg_done',
        command: 'ls',
        status: 'exited',
        exitCode: 0,
        processId: 'p1',
        id: '0',
      }),
    ).toBe(
      '[background] `ls` exited (exit 0). process_id=p1 — read complete output with bash_output.',
    );
  });

  test('bg_done with a null exit code omits the "(exit N)" suffix', () => {
    expect(
      formatNotificationHeadline({
        kind: 'bg_done',
        command: 'x',
        status: 'killed',
        exitCode: null,
        processId: 'p2',
        id: '0',
      }),
    ).toContain('killed. process_id=p2');
  });

  test('reminder is the note, control-flattened', () => {
    expect(
      formatNotificationHeadline({ kind: 'reminder', note: 'a\nb', scheduledAt: 0, id: '0' }),
    ).toBe(
      '[reminder] a b', // newline flattened to a single row
    );
  });

  test('peer_message names the peer channel (anti-spoof flattened alias)', () => {
    expect(
      formatNotificationHeadline({ kind: 'peer_message', peerAlias: 'alice', text: 'hi', id: '0' }),
    ).toBe("▸ peer 'alice'");
  });

  test('peer_reply_nudge points at mesh_send', () => {
    const h = formatNotificationHeadline({ kind: 'peer_reply_nudge', aliases: ['alice'], id: '0' });
    expect(h).toContain('[reply pending]');
    expect(h).toContain('mesh_send');
    expect(h).toContain('peer '); // singular grammar branch
  });

  test('peer_reply_nudge with multiple aliases uses plural grammar and a comma-joined list', () => {
    const h = formatNotificationHeadline({
      kind: 'peer_reply_nudge',
      aliases: ['alice', 'bob'],
      id: '0',
    });
    expect(h).toContain("'alice', 'bob'"); // comma-joined who-list
    expect(h).toContain('peers'); // plural noun
    expect(h).toContain(' are '); // plural verb
    expect(h).toContain('reach them'); // plural object
  });
});

describe('formatNotification (model wake-turn input)', () => {
  test('bg_done rides its summary body under the headline', () => {
    const n = {
      kind: 'bg_done' as const,
      command: 'test',
      status: 'exited' as const,
      exitCode: 0,
      processId: 'p1',
      summary: 'ok',
      id: '0',
    };
    expect(formatNotification(n)).toBe(`${formatNotificationHeadline(n)}\nok`);
  });

  test('reminder is headline-only (no body)', () => {
    const n = { kind: 'reminder' as const, note: 'ping', scheduledAt: 0, id: '0' };
    expect(formatNotification(n)).toBe(formatNotificationHeadline(n));
  });

  test('peer_message is enveloped as untrusted DATA, not the operator headline', () => {
    const n = { kind: 'peer_message' as const, peerAlias: 'alice', text: 'do the thing', id: '0' };
    const out = formatNotification(n);
    expect(out).not.toBe(formatNotificationHeadline(n)); // uses framePeerMessage, not the headline
    expect(out).toContain('do the thing'); // the raw text is carried through the envelope
  });
});

describe('NotificationQueue', () => {
  const bg = (): NotificationPayload => ({
    kind: 'bg_done',
    command: 'c',
    status: 'exited',
    exitCode: 0,
    processId: 'p',
  });
  const peer = (text: string): NotificationPayload => ({
    kind: 'peer_message',
    peerAlias: 'a',
    text,
  });

  test('push stamps monotonic ids; size reflects the pending count', () => {
    const q = new NotificationQueue();
    expect(q.size()).toBe(0);
    q.push(bg());
    q.push(peer('x'));
    expect(q.size()).toBe(2);
    expect(q.drainAll().map((n) => n.id)).toEqual(['0', '1']);
  });

  test('peerMessageCount counts only peer_message entries', () => {
    const q = new NotificationQueue();
    q.push(bg());
    q.push(peer('x'));
    q.push(peer('y'));
    expect(q.peerMessageCount()).toBe(2);
  });

  test('drainAll returns the whole batch and empties the queue', () => {
    const q = new NotificationQueue();
    q.push(bg());
    q.push(peer('x'));
    const drained = q.drainAll();
    expect(drained).toHaveLength(2);
    expect(q.size()).toBe(0);
    expect(q.drainAll()).toEqual([]); // second drain is empty
  });

  test('push preserves the payload variant fields, adding only the id', () => {
    const q = new NotificationQueue();
    const payload = bg();
    q.push(payload);
    // The `as Notification` cast must not drop or reshape variant fields.
    expect(q.drainAll()).toEqual([{ ...payload, id: '0' }]);
  });
});
