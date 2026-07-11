import { describe, expect, test } from 'bun:test';
import { readFs, writeFs } from '../../src/permissions/capabilities.ts';
import {
  buildClassifierInput,
  CLASSIFIER_ADJUST_BOUNDS,
  clampAdjust,
  createNoopClassifier,
  validateClassifierOutput,
} from '../../src/permissions/classifier.ts';

describe('clampAdjust', () => {
  test('values inside bounds pass through unchanged', () => {
    expect(clampAdjust(0)).toBe(0);
    expect(clampAdjust(0.1)).toBe(0.1);
    expect(clampAdjust(-0.1)).toBe(-0.1);
    expect(clampAdjust(0.2)).toBe(0.2);
    expect(clampAdjust(-0.2)).toBe(-0.2);
  });
  test('values above max clamp to max', () => {
    expect(clampAdjust(0.5)).toBe(CLASSIFIER_ADJUST_BOUNDS.max);
    expect(clampAdjust(1.0)).toBe(CLASSIFIER_ADJUST_BOUNDS.max);
    expect(clampAdjust(Number.POSITIVE_INFINITY)).toBe(CLASSIFIER_ADJUST_BOUNDS.max);
  });
  test('values below min clamp to min', () => {
    expect(clampAdjust(-0.5)).toBe(CLASSIFIER_ADJUST_BOUNDS.min);
    expect(clampAdjust(-2)).toBe(CLASSIFIER_ADJUST_BOUNDS.min);
    expect(clampAdjust(Number.NEGATIVE_INFINITY)).toBe(CLASSIFIER_ADJUST_BOUNDS.min);
  });
  test('NaN canonicalizes to 0 (chain-hash stability)', () => {
    expect(clampAdjust(Number.NaN)).toBe(0);
  });
});

describe('validateClassifierOutput', () => {
  test('valid object passes through', () => {
    expect(validateClassifierOutput({ score_adjust: 0.1, reason: 'benign build script' })).toEqual({
      score_adjust: 0.1,
      reason: 'benign build script',
    });
  });
  test('missing score_adjust → null', () => {
    expect(validateClassifierOutput({ reason: 'x' })).toBeNull();
  });
  test('missing reason → null', () => {
    expect(validateClassifierOutput({ score_adjust: 0.1 })).toBeNull();
  });
  test('wrong type score_adjust → null', () => {
    expect(validateClassifierOutput({ score_adjust: '0.1', reason: 'x' })).toBeNull();
  });
  test('wrong type reason → null', () => {
    expect(validateClassifierOutput({ score_adjust: 0.1, reason: 123 })).toBeNull();
  });
  test('NaN score_adjust → null (distinct from clamp-to-zero)', () => {
    expect(validateClassifierOutput({ score_adjust: Number.NaN, reason: 'x' })).toBeNull();
  });
  test('null / non-object inputs → null', () => {
    expect(validateClassifierOutput(null)).toBeNull();
    expect(validateClassifierOutput('string')).toBeNull();
    expect(validateClassifierOutput(123)).toBeNull();
    expect(validateClassifierOutput(undefined)).toBeNull();
  });
  test('extra fields are ignored, not rejected', () => {
    const r = validateClassifierOutput({
      score_adjust: 0.05,
      reason: 'ok',
      extra: 'ignored',
    });
    expect(r).toEqual({ score_adjust: 0.05, reason: 'ok' });
  });
});

describe('createNoopClassifier', () => {
  test('returns null for any input', () => {
    const noop = createNoopClassifier();
    expect(
      noop({
        toolName: 'bash',
        capabilities: [],
        score: 0,
        classifierHash: 'none',
      }),
    ).toBeNull();
  });
});

describe('buildClassifierInput', () => {
  test('capabilities are formatted strings, not raw objects', () => {
    const input = buildClassifierInput({
      toolName: 'bash',
      capabilities: [readFs('/work/proj/src'), writeFs('/work/proj/dist')],
      score: 0.4,
      classifierHash: 'v0.3',
    });
    expect(input.capabilities).toEqual(['read-fs:/work/proj/src', 'write-fs:/work/proj/dist']);
    expect(input.toolName).toBe('bash');
    expect(input.score).toBe(0.4);
    expect(input.classifierHash).toBe('v0.3');
  });
  test('contextSummary omitted by default', () => {
    const input = buildClassifierInput({
      toolName: 'bash',
      capabilities: [],
      score: 0,
      classifierHash: 'none',
    });
    expect(input.contextSummary).toBeUndefined();
  });
  test('contextSummary preserved when supplied', () => {
    const input = buildClassifierInput({
      toolName: 'bash',
      capabilities: [],
      score: 0,
      classifierHash: 'v1',
      contextSummary: 'recent: 3 reads under src/',
    });
    expect(input.contextSummary).toBe('recent: 3 reads under src/');
  });
});
