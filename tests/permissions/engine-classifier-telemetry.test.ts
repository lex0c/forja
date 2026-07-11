import { describe, expect, test } from 'bun:test';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import type { Policy } from '../../src/permissions/types.ts';
import {
  type ClassifierUnavailableEvent,
  createRecordingTelemetrySink,
} from '../../src/telemetry/index.ts';

const baseStrictPolicy = (): Policy => ({
  defaults: { mode: 'strict' },
  tools: {
    read_file: { allow_paths: ['**'] },
  },
});

describe('engine.check — classifier.unavailable telemetry (§18 / slice 74)', () => {
  // `engine.check` emits a structured `classifier.unavailable`
  // event when the classifier returns null, throws, or yields an
  // invalid schema. Spec §18 line 1211 lists this as a tracked
  // metric (alarm threshold: >5% of decisions). The event fires
  // regardless of `classifierRequired`; the `strict` field
  // captures the operational impact (lenient continues with the
  // deterministic score; strict transitions the engine to
  // degraded).

  test('classifier returning null → emits reason=unavailable', () => {
    const telemetry = createRecordingTelemetrySink();
    const engine = createPermissionEngine(baseStrictPolicy(), {
      cwd: '/work',
      audit: {
        emit: () => ({ seq: 0, this_hash: '' }),
        verifyChain: () => ({ ok: true, rows: 0, current_rotation_id: 0, quarantined: false }),
      },
      classifier: () => null,
      classifierHash: 'fixture-v1',
      telemetry,
      now: () => 12345,
    });
    engine.check('read_file', 'fs.read', { file_path: 'src/x.ts' });
    const events = telemetry
      .events()
      .filter((e): e is ClassifierUnavailableEvent => e.kind === 'classifier.unavailable');
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('expected event');
    expect(event.reason).toBe('unavailable');
    expect(event.tool).toBe('read_file');
    expect(event.classifier_hash).toBe('fixture-v1');
    expect(event.strict).toBe(false);
    expect(event.ts).toBe(12345);
  });

  test('classifier throwing → emits reason=threw', () => {
    const telemetry = createRecordingTelemetrySink();
    const engine = createPermissionEngine(baseStrictPolicy(), {
      cwd: '/work',
      audit: {
        emit: () => ({ seq: 0, this_hash: '' }),
        verifyChain: () => ({ ok: true, rows: 0, current_rotation_id: 0, quarantined: false }),
      },
      classifier: () => {
        throw new Error('classifier exploded');
      },
      classifierHash: 'v1',
      telemetry,
      now: () => 1,
    });
    engine.check('read_file', 'fs.read', { file_path: 'src/x.ts' });
    const events = telemetry
      .events()
      .filter((e): e is ClassifierUnavailableEvent => e.kind === 'classifier.unavailable');
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe('threw');
  });

  test('classifier returning malformed shape → emits reason=invalid', () => {
    const telemetry = createRecordingTelemetrySink();
    const engine = createPermissionEngine(baseStrictPolicy(), {
      cwd: '/work',
      audit: {
        emit: () => ({ seq: 0, this_hash: '' }),
        verifyChain: () => ({ ok: true, rows: 0, current_rotation_id: 0, quarantined: false }),
      },
      // Cast through unknown to force the malformed shape past TS.
      classifier: (() => ({ wrong: 'shape' })) as unknown as (
        input: Parameters<
          NonNullable<Parameters<typeof createPermissionEngine>[1]['classifier']>
        >[0],
      ) => null,
      classifierHash: 'v1',
      telemetry,
      now: () => 1,
    });
    engine.check('read_file', 'fs.read', { file_path: 'src/x.ts' });
    const events = telemetry
      .events()
      .filter((e): e is ClassifierUnavailableEvent => e.kind === 'classifier.unavailable');
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe('invalid');
  });

  test('strict mode → emits event with strict=true AND degrades engine', () => {
    const telemetry = createRecordingTelemetrySink();
    const engine = createPermissionEngine(baseStrictPolicy(), {
      cwd: '/work',
      audit: {
        emit: () => ({ seq: 0, this_hash: '' }),
        verifyChain: () => ({ ok: true, rows: 0, current_rotation_id: 0, quarantined: false }),
      },
      classifier: () => null,
      classifierHash: 'v1',
      classifierRequired: true,
      telemetry,
      now: () => 1,
    });
    expect(engine.state()).toBe('ready');
    engine.check('read_file', 'fs.read', { file_path: 'src/x.ts' });
    const events = telemetry
      .events()
      .filter((e): e is ClassifierUnavailableEvent => e.kind === 'classifier.unavailable');
    expect(events).toHaveLength(1);
    expect(events[0]?.strict).toBe(true);
    expect(engine.state()).toBe('degraded');
  });

  test('NO telemetry option → engine still degrades on strict + unavailable', () => {
    // Regression guard: pre-slice-74 behavior preserved when
    // telemetry is omitted.
    const engine = createPermissionEngine(baseStrictPolicy(), {
      cwd: '/work',
      audit: {
        emit: () => ({ seq: 0, this_hash: '' }),
        verifyChain: () => ({ ok: true, rows: 0, current_rotation_id: 0, quarantined: false }),
      },
      classifier: () => null,
      classifierRequired: true,
    });
    engine.check('read_file', 'fs.read', { file_path: 'src/x.ts' });
    expect(engine.state()).toBe('degraded');
  });

  test('classifier wired + responds normally → NO classifier.unavailable event', () => {
    const telemetry = createRecordingTelemetrySink();
    const engine = createPermissionEngine(baseStrictPolicy(), {
      cwd: '/work',
      audit: {
        emit: () => ({ seq: 0, this_hash: '' }),
        verifyChain: () => ({ ok: true, rows: 0, current_rotation_id: 0, quarantined: false }),
      },
      classifier: () => ({ score_adjust: 0.05, reason: 'fine' }),
      classifierHash: 'v1',
      telemetry,
      now: () => 1,
    });
    engine.check('read_file', 'fs.read', { file_path: 'src/x.ts' });
    const events = telemetry.events().filter((e) => e.kind === 'classifier.unavailable');
    expect(events).toHaveLength(0);
  });

  test('telemetry.emit throwing inside the classifier branch does NOT break check()', () => {
    const engine = createPermissionEngine(baseStrictPolicy(), {
      cwd: '/work',
      audit: {
        emit: () => ({ seq: 0, this_hash: '' }),
        verifyChain: () => ({ ok: true, rows: 0, current_rotation_id: 0, quarantined: false }),
      },
      classifier: () => null,
      classifierRequired: true,
      telemetry: {
        emit: () => {
          throw new Error('synthetic telemetry failure');
        },
      },
    });
    // engine.check shouldn't propagate the throw; it should still
    // return a decision + degrade the engine.
    const decision = engine.check('read_file', 'fs.read', { file_path: 'src/x.ts' });
    expect(typeof decision.kind).toBe('string');
    expect(engine.state()).toBe('degraded');
  });
});
