import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { recordUpdateProbe } from '../../src/storage/repos/update-check.ts';
import { formatPermanent } from '../../src/tui/render/permanent.ts';
import { applyEvent, createInitialState } from '../../src/tui/state.ts';
import type { Capabilities } from '../../src/tui/term.ts';
import { markNoticeShown, peekUpdateNotice } from '../../src/update/boot.ts';

const ascii: Capabilities = { isTTY: true, cols: 80, rows: 24, color: 'none', unicode: false };

// End-to-end data path of the passive notice, exactly as runRepl's boot wires
// it (SECURITY_GUIDELINE §11.4): local cache → peekUpdateNotice → the
// update:available event → reducer → rendered scrollback line, then
// markNoticeShown AFTER the emit. The opt-in gate itself (a plain boolean in
// runRepl) is typecheck-covered; --json / CI / non-TTY are refused upstream.
describe('update notice — boot data path', () => {
  test('a newer cached release renders the accent line with the origin-aware update command', () => {
    const db = openDb(':memory:');
    migrate(db);
    // A refresh in a previous session recorded a newer release.
    recordUpdateProbe(db, 1000, '9.9.9');

    // Boot step: peek the notice against the running binary version (no mark yet).
    const notice = peekUpdateNotice(db, '0.1.3');
    if (notice === null) throw new Error('expected a notice for a newer cached release');

    // Wired into the bus as update:available → reducer → permanent item → line.
    const r = applyEvent(createInitialState(), {
      type: 'update:available',
      ts: 2000,
      current: notice.current,
      latest: notice.latest,
      command: notice.command,
    });
    const body = r.permanent.flatMap((item) => formatPermanent(item, ascii)).join('\n');
    expect(body).toContain('Forja v9.9.9 available!');
    expect(body).toContain(`Update: ${notice.command}`);

    // Mark after emit (as the wire does), then a second boot is silent.
    markNoticeShown(db, notice.latest);
    expect(peekUpdateNotice(db, '0.1.3')).toBeNull();
    db.close();
  });
});
