import { describe, expect, test } from 'bun:test';
import {
  OUTPUT_SCHEMA_BLOCK_HEADER,
  buildOutputSchemaBlock,
  composeWithOutputSchemaBlock,
} from '../../src/cli/output-schema-block.ts';

describe('buildOutputSchemaBlock', () => {
  test('returns null on null / undefined / non-object', () => {
    expect(buildOutputSchemaBlock(null)).toBeNull();
    expect(buildOutputSchemaBlock(undefined)).toBeNull();
    expect(buildOutputSchemaBlock('a string')).toBeNull();
    expect(buildOutputSchemaBlock([1, 2, 3])).toBeNull();
  });

  test('returns null on empty schema', () => {
    expect(buildOutputSchemaBlock({})).toBeNull();
  });

  test('renders the canonical header on a valid schema', () => {
    const out = buildOutputSchemaBlock({ summary: 'string' });
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.startsWith(OUTPUT_SCHEMA_BLOCK_HEADER)).toBe(true);
  });

  test('embeds the schema as a yaml code fence', () => {
    const out = buildOutputSchemaBlock({ summary: 'string', blockers: 'array' });
    if (out === null) return;
    // Code fence with `yaml` language hint so the model knows
    // the dialect to mirror in its output.
    expect(out).toContain('```yaml');
    expect(out).toContain('summary: string');
    expect(out).toContain('blockers: array');
    expect(out).toContain('```');
  });

  test('preamble names the retry contract', () => {
    // Spec PLAYBOOKS.md §1.2: the model gets exactly ONE retry
    // before the run fails. The preamble must surface that
    // contract — without it, the model has no incentive to take
    // the retry diagnostic seriously.
    const out = buildOutputSchemaBlock({ summary: 'string' });
    if (out === null) return;
    expect(out).toContain('ONE retry');
    expect(out).toContain('playbook.output_invalid');
  });

  test('handles JSON Schema dialect equally', () => {
    const out = buildOutputSchemaBlock({
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string' } },
    });
    if (out === null) return;
    expect(out).toContain('type: object');
    expect(out).toContain('required:');
    expect(out).toContain('summary');
  });
});

describe('composeWithOutputSchemaBlock', () => {
  test('returns downstream untouched when there is no schema', () => {
    expect(composeWithOutputSchemaBlock('body', null)).toBe('body');
    expect(composeWithOutputSchemaBlock('body', undefined)).toBe('body');
    expect(composeWithOutputSchemaBlock('body', {})).toBe('body');
  });

  test('appends the block AFTER the body with the standard separator', () => {
    const out = composeWithOutputSchemaBlock('You are review.', { summary: 'string' });
    if (out === undefined) return;
    const bodyIdx = out.indexOf('You are review.');
    const sepIdx = out.indexOf('---');
    const headerIdx = out.indexOf(OUTPUT_SCHEMA_BLOCK_HEADER);
    expect(bodyIdx).toBe(0);
    expect(sepIdx).toBeGreaterThan(bodyIdx);
    expect(headerIdx).toBeGreaterThan(sepIdx);
  });

  test('returns block alone when downstream is undefined', () => {
    const out = composeWithOutputSchemaBlock(undefined, { summary: 'string' });
    if (out === undefined) return;
    expect(out.startsWith(OUTPUT_SCHEMA_BLOCK_HEADER)).toBe(true);
  });

  test('returns block alone when downstream is empty', () => {
    const out = composeWithOutputSchemaBlock('', { summary: 'string' });
    if (out === undefined) return;
    expect(out.startsWith(OUTPUT_SCHEMA_BLOCK_HEADER)).toBe(true);
  });

  test('returns undefined when both downstream and schema absent', () => {
    expect(composeWithOutputSchemaBlock(undefined, undefined)).toBeUndefined();
    expect(composeWithOutputSchemaBlock(undefined, null)).toBeUndefined();
    expect(composeWithOutputSchemaBlock(undefined, {})).toBeUndefined();
  });
});
