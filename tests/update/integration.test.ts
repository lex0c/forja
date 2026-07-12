import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { recordUpdateProbe } from '../../src/storage/repos/update-check.ts';
import { formatPermanent } from '../../src/tui/render/permanent.ts';
import { applyEvent, createInitialState } from '../../src/tui/state.ts';
import type { Capabilities } from '../../src/tui/term.ts';
import { takeUpdateNotice } from '../../src/update/boot.ts';

const ascii: Capabilities = { isTTY: true, cols: 80, rows: 24, color: 'none', unicode: false };

// End-to-end data path of the passive notice, exactly as runRepl's boot wires
// it (SECURITY_GUIDELINE §11.4): local cache → takeUpdateNotice → the
// update:available event → reducer → rendered scrollback line. The only thing
// NOT exercised here is the opt-in gate itself (`if (updateCheckEnabled)` in
// runRepl), a plain boolean the typechecker covers; --json / CI / non-TTY are
// refused upstream before runRepl, verified separately.
describe('update notice — boot data path', () => {
  test('a newer cached release renders the accent line pointing at `forja update`', () => {
    const db = openDb(':memory:');
    migrate(db);
    // A refresh in a previous session recorded a newer release.
    recordUpdateProbe(db, 1000, '9.9.9');

    // Boot step: decide + take the notice against the running binary version.
    const notice = takeUpdateNotice(db, '0.1.3');
    if (notice === null) throw new Error('expected a notice for a newer cached release');

    // Wired into the bus as update:available → reducer → permanent item → line.
    const r = applyEvent(createInitialState(), {
      type: 'update:available',
      ts: 2000,
      current: notice.current,
      latest: notice.latest,
    });
    const body = r.permanent.flatMap((item) => formatPermanent(item, ascii)).join('\n');
    expect(body).toContain('Forja v9.9.9 available');
    expect(body).toContain('(you have v0.1.3)');
    expect(body).toContain('forja update');

    // Once per release: a second boot with the same cache is silent.
    expect(takeUpdateNotice(db, '0.1.3')).toBeNull();
    db.close();
  });
});
