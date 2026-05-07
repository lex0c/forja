import { describe, expect, test } from 'bun:test';
import {
  REFERENCE_BLOCK_HEADER,
  buildReferenceBlock,
  composeWithReferenceBlock,
} from '../../src/cli/reference-block.ts';

describe('buildReferenceBlock', () => {
  test('returns null on undefined / null / empty list', () => {
    expect(buildReferenceBlock(undefined)).toBeNull();
    expect(buildReferenceBlock(null)).toBeNull();
    expect(buildReferenceBlock([])).toBeNull();
  });

  test('renders a single-entry block with the canonical header', () => {
    const out = buildReferenceBlock(['OPSEC.md']);
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.startsWith(REFERENCE_BLOCK_HEADER)).toBe(true);
    expect(out).toContain('- OPSEC.md');
  });

  test('renders multiple entries as a bullet list in declared order', () => {
    // Order matters: the playbook author's order is the operator's
    // mental model of "primary refs first". A sort here would
    // hide that intent. Pinning the order anchors the contract.
    const out = buildReferenceBlock(['THREAT_MODELING.md', 'ZERO_TRUST.md', 'CRYPTOGRAPHY.md']);
    expect(out).not.toBeNull();
    if (out === null) return;
    const threatIdx = out.indexOf('- THREAT_MODELING.md');
    const zeroIdx = out.indexOf('- ZERO_TRUST.md');
    const cryptoIdx = out.indexOf('- CRYPTOGRAPHY.md');
    expect(threatIdx).toBeGreaterThan(0);
    expect(zeroIdx).toBeGreaterThan(threatIdx);
    expect(cryptoIdx).toBeGreaterThan(zeroIdx);
  });

  test('mentions read_file as the read mechanism', () => {
    // The block tells the model HOW to consult the docs. Without
    // citing `read_file`, the model might invent a different
    // mechanism (web fetch, embedded content, etc.) — the
    // playbook contract is that references are filesystem paths
    // resolved by the standard read tool.
    const out = buildReferenceBlock(['DOC.md']);
    if (out === null) return;
    expect(out).toContain('read_file');
  });

  test('refuses to embed eagerly (anti-pattern PLAYBOOKS §13)', () => {
    // Spec PLAYBOOKS.md §13 calls out "embarcar OPSEC.md inteira
    // no prompt" as a top anti-pattern. The block must
    // explicitly tell the model NOT to load eagerly; the
    // language matters.
    const out = buildReferenceBlock(['DOC.md']);
    if (out === null) return;
    expect(out.toLowerCase()).toContain('do not embed eagerly');
  });

  test('preserves path verbatim (no escaping for markdown chars)', () => {
    // Identifiers are filenames, not markdown that needs
    // sanitizing. A path with `_` or `*` would, in a sanitizing
    // pass, get escaped — diverging from what the .md said. Spec
    // assumes paths are well-formed at the source.
    const out = buildReferenceBlock(['ANTI_PATTERNS_AND_CODE_ENTROPY.md']);
    if (out === null) return;
    expect(out).toContain('- ANTI_PATTERNS_AND_CODE_ENTROPY.md');
  });
});

describe('composeWithReferenceBlock', () => {
  test('returns downstream unchanged when no refs to render', () => {
    expect(composeWithReferenceBlock('body', undefined)).toBe('body');
    expect(composeWithReferenceBlock('body', null)).toBe('body');
    expect(composeWithReferenceBlock('body', [])).toBe('body');
  });

  test('returns undefined when both downstream and refs are absent', () => {
    expect(composeWithReferenceBlock(undefined, undefined)).toBeUndefined();
    expect(composeWithReferenceBlock(undefined, [])).toBeUndefined();
  });

  test('returns block alone when downstream is undefined', () => {
    const out = composeWithReferenceBlock(undefined, ['DOC.md']);
    expect(out).not.toBeUndefined();
    if (out === undefined) return;
    expect(out.startsWith(REFERENCE_BLOCK_HEADER)).toBe(true);
    // No separator at the top — without downstream, the block
    // is the whole prompt fragment.
    expect(out.startsWith('---')).toBe(false);
  });

  test('returns block alone when downstream is empty string', () => {
    const out = composeWithReferenceBlock('', ['DOC.md']);
    if (out === undefined) return;
    expect(out.startsWith(REFERENCE_BLOCK_HEADER)).toBe(true);
  });

  test('appends block AFTER downstream with separator', () => {
    const out = composeWithReferenceBlock('You are review.', ['CODE_COMMODITY.md']);
    if (out === undefined) return;
    const bodyIdx = out.indexOf('You are review.');
    const sepIdx = out.indexOf('---');
    const headerIdx = out.indexOf(REFERENCE_BLOCK_HEADER);
    expect(bodyIdx).toBe(0);
    expect(sepIdx).toBeGreaterThan(bodyIdx);
    expect(headerIdx).toBeGreaterThan(sepIdx);
  });

  test('separator surface matches the parallel-hint convention', () => {
    // Both the parallel hint (prefix) and the reference block
    // (suffix) use the same `\n\n---\n\n` separator so the model
    // sees a single fence shape regardless of which side a
    // section was added from. Anchoring this keeps the prompt
    // grammar uniform.
    const out = composeWithReferenceBlock('body', ['X.md']) ?? '';
    expect(out).toContain('\n\n---\n\n');
  });
});
