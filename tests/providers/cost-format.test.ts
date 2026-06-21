import { describe, expect, test } from 'bun:test';
import {
  UNMETERED_LABEL,
  formatCostCell,
  isUnmetered,
  isUnmeteredModel,
} from '../../src/providers/cost-format.ts';
import type { ModelRegistry } from '../../src/providers/registry.ts';
import type { Provider, ProviderCapabilities } from '../../src/providers/types.ts';

const caps = (over: Partial<ProviderCapabilities>): ProviderCapabilities =>
  over as ProviderCapabilities;

describe('formatCostCell', () => {
  const fmt = (usd: number): string => `$${usd.toFixed(4)}`;
  test('unmetered + ZERO recorded cost → the label ($0 is untracked, not free)', () => {
    expect(formatCostCell(true, true, fmt, 0)).toBe(UNMETERED_LABEL);
    expect(formatCostCell(true, false, fmt, 0)).toBe(UNMETERED_LABEL);
  });
  test('unmetered BUT nonzero recorded cost → the dollars win, never hidden by the label', () => {
    // A historical session whose row model resolves unmetered but that switched via /model
    // to a metered one carries real recorded spend — the label must not replace it.
    expect(formatCostCell(true, true, fmt, 0.5)).toBe('$0.5000');
    expect(formatCostCell(true, false, fmt, 0.5)).toBe('~$0.5000');
  });
  test('metered + complete → the formatted dollar amount', () => {
    expect(formatCostCell(false, true, fmt, 0.0123)).toBe('$0.0123');
  });
  test('metered + incomplete → the ~ lower-bound prefix', () => {
    expect(formatCostCell(false, false, fmt, 0.0123)).toBe('~$0.0123');
  });
});

describe('isUnmetered (live provider)', () => {
  const p = (unmetered?: boolean): Pick<Provider, 'capabilities'> => ({
    capabilities: caps(unmetered === undefined ? {} : { unmetered }),
  });
  test('reads the capability flag (absent ⇒ metered)', () => {
    expect(isUnmetered(p(true))).toBe(true);
    expect(isUnmetered(p(false))).toBe(false);
    expect(isUnmetered(p())).toBe(false);
  });
});

describe('isUnmeteredModel (historical, via registry)', () => {
  const reg = {
    get: (id: string) =>
      id === 'x/unmet'
        ? { capabilities: caps({ unmetered: true }) }
        : id === 'x/met'
          ? { capabilities: caps({}) }
          : null,
  } as unknown as ModelRegistry;
  test('resolves an id against the registry; unknown model ⇒ false (show cost)', () => {
    expect(isUnmeteredModel(reg, 'x/unmet')).toBe(true);
    expect(isUnmeteredModel(reg, 'x/met')).toBe(false);
    expect(isUnmeteredModel(reg, 'x/gone')).toBe(false);
  });
});
