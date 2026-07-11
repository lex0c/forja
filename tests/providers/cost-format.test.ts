import { describe, expect, test } from 'bun:test';
import {
  formatCostCell,
  isSessionUnmetered,
  isUnmetered,
  isUnmeteredModel,
  UNMETERED_LABEL,
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

describe('isSessionUnmetered (per-turn provenance, migration 077)', () => {
  const reg = {
    get: (id: string) =>
      id === 'x/unmet' || id === 'x/unmet2'
        ? { capabilities: caps({ unmetered: true }) }
        : id === 'x/met'
          ? { capabilities: caps({}) }
          : null,
  } as unknown as ModelRegistry;

  test('every model unmetered ⇒ unmetered (the recorded $ is untracked)', () => {
    expect(isSessionUnmetered(reg, ['x/unmet', 'x/unmet2'])).toBe(true);
  });
  test('ANY metered model ⇒ NOT unmetered, even mixed with an unmetered one', () => {
    // The switched-session bug: started unmetered, then /model-switched to a metered
    // model. The metered spend is real, so the row must NOT read as "unmetered".
    expect(isSessionUnmetered(reg, ['x/unmet', 'x/met'])).toBe(false);
    expect(isSessionUnmetered(reg, ['x/met'])).toBe(false);
  });
  test('empty model set ⇒ not unmetered (guard; callers pass effective, non-empty models)', () => {
    // The fallback to sessions.model lives in `effectiveSessionModels`, so an empty set
    // here is misuse — it must NOT read as vacuously unmetered (`[].every() === true`).
    expect(isSessionUnmetered(reg, [])).toBe(false);
  });
  test('an unknown model (dropped from the catalog) counts as metered', () => {
    expect(isSessionUnmetered(reg, ['x/gone'])).toBe(false);
  });
});
