import { describe, expect, test } from 'bun:test';
import {
  applyWorkingStatePatch,
  createWorkingStateStore,
  emptyWorkingState,
  formatWorkingState,
  type WorkingState,
  WS_CAPS,
} from '../../src/working-state/index.ts';

// A fresh nextId generator for the pure-function tests (the store owns the real
// one; here we just need stable, monotonic ids).
const idGen = () => {
  let n = 0;
  return () => {
    n += 1;
    return `H${n}`;
  };
};

const apply = (
  state: WorkingState,
  patch: Parameters<typeof applyWorkingStatePatch>[1],
  step: number,
  gen = idGen(),
) => applyWorkingStatePatch(state, patch, step, gen);

describe('WorkingStateStore (container)', () => {
  test('returns an empty state for an unknown session', () => {
    const store = createWorkingStateStore();
    expect(store.get('s1')).toEqual(emptyWorkingState());
  });

  test('set then get round-trips', () => {
    const store = createWorkingStateStore();
    const state: WorkingState = {
      focus: { text: 'do x', atStep: 3 },
      next: ['a', 'b'],
      log: [{ text: 'm1', atStep: 2 }],
      hypotheses: [
        { id: 'H1', text: 'h', status: 'open', source: 'model', evidence: [], updatedAtStep: 3 },
      ],
    };
    store.set('s1', state);
    expect(store.get('s1')).toEqual(state);
  });

  test('state is per-session and isolated by deep clone', () => {
    const store = createWorkingStateStore();
    store.set('s1', { ...emptyWorkingState(), next: ['only-s1'] });
    expect(store.get('s2')).toEqual(emptyWorkingState());
    const got = store.get('s1');
    got.next.push('mutated');
    // mutating the returned copy must not change stored state
    expect(store.get('s1').next).toEqual(['only-s1']);
  });

  test('nextId is monotonic, H-prefixed, and never recycled', () => {
    const store = createWorkingStateStore();
    expect(store.nextId('s1')).toBe('H1');
    expect(store.nextId('s1')).toBe('H2');
    expect(store.nextId('s2')).toBe('H1'); // independent per session
  });

  test('clear drops state and resets the id counter', () => {
    const store = createWorkingStateStore();
    store.set('s1', { ...emptyWorkingState(), next: ['x'] });
    store.nextId('s1');
    store.clear('s1');
    expect(store.get('s1')).toEqual(emptyWorkingState());
    expect(store.nextId('s1')).toBe('H1');
  });
});

describe('WorkingStateStore — session step counter', () => {
  test('tickStep advances monotonically; currentStep peeks; per-session', () => {
    const store = createWorkingStateStore();
    expect(store.currentStep('s1')).toBe(0);
    expect(store.tickStep('s1')).toBe(1);
    expect(store.tickStep('s1')).toBe(2);
    expect(store.currentStep('s1')).toBe(2); // peek does not advance
    expect(store.tickStep('s2')).toBe(1); // independent per session
  });

  test('step survives set()/get() (no reset) and is dropped by clear()', () => {
    const store = createWorkingStateStore();
    store.tickStep('s1');
    store.tickStep('s1');
    store.set('s1', { ...emptyWorkingState(), next: ['x'] });
    store.get('s1');
    expect(store.currentStep('s1')).toBe(2); // a turn's reads/writes don't reset it
    store.clear('s1');
    expect(store.currentStep('s1')).toBe(0);
  });

  test('staleness stays monotonic across a simulated REPL turn boundary', () => {
    // Turn 1 fills the open-hypothesis cap at increasing session steps. A new
    // runAgent (turn 2) resets its per-run step index to 0 — but the store's
    // session step keeps climbing, so the just-added hypothesis is the NEWEST
    // and the genuinely-oldest is evicted (not the just-added, which the old
    // per-run-step bug would have done).
    const store = createWorkingStateStore();
    const gen = () => store.nextId('s1');
    let state = emptyWorkingState();
    for (let i = 1; i <= WS_CAPS.hypothesesMaxOpen; i++) {
      const step = store.tickStep('s1'); // turn-1 session steps 1..7
      state = applyWorkingStatePatch(state, { hypothesisAdd: { text: `h${i}` } }, step, gen).next;
    }
    const step = store.tickStep('s1'); // turn 2: 8, NOT a reset to 1
    expect(step).toBe(WS_CAPS.hypothesesMaxOpen + 1);
    const r = applyWorkingStatePatch(state, { hypothesisAdd: { text: 'newest' } }, step, gen);
    expect(r.next.hypotheses.find((h) => h.text === 'newest')).toBeDefined(); // survives
    expect(r.next.hypotheses.find((h) => h.id === 'H1')).toBeUndefined(); // oldest evicted
    expect(r.mutations.hypothesisEvicted).toBe(1);
  });
});

describe('applyWorkingStatePatch — focus & next', () => {
  test('focus set stamps the step; empty string clears it', () => {
    const r1 = apply(emptyWorkingState(), { focus: 'investigate cache' }, 5);
    expect(r1.next.focus).toEqual({ text: 'investigate cache', atStep: 5 });
    expect(r1.mutations.focusChanged).toBe(1);

    const r2 = apply(r1.next, { focus: '' }, 6);
    expect(r2.next.focus).toBeUndefined();
  });

  test('focus is flattened to one line and capped', () => {
    const r = apply(emptyWorkingState(), { focus: 'multi\nline\tfocus' }, 1);
    expect(r.next.focus?.text).toBe('multi line focus');

    const long = 'x'.repeat(WS_CAPS.focusMaxChars + 50);
    const r2 = apply(emptyWorkingState(), { focus: long }, 1);
    expect(r2.next.focus?.text.length).toBe(WS_CAPS.focusMaxChars);
    expect(r2.next.focus?.text.endsWith('…')).toBe(true);
  });

  test('next replaces the list, caps at nextMax, and warns on overflow', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const r = apply(emptyWorkingState(), { next: items }, 1);
    expect(r.next.next).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.mutations.nextSet).toBe(1);
    expect(r.notices.some((n) => n.includes('todo_create'))).toBe(true);
  });

  test('next drops empty/whitespace items', () => {
    const r = apply(emptyWorkingState(), { next: ['a', '   ', '', 'b'] }, 1);
    expect(r.next.next).toEqual(['a', 'b']);
  });
});

describe('applyWorkingStatePatch — log FIFO', () => {
  test('append grows the log and counts mutations', () => {
    const r = apply(emptyWorkingState(), { logAppend: ['m1', 'm2'] }, 4);
    expect(r.next.log).toEqual([
      { text: 'm1', atStep: 4 },
      { text: 'm2', atStep: 4 },
    ]);
    expect(r.mutations.logAppended).toBe(2);
  });

  test('FIFO keeps only the newest logMax entries', () => {
    let state = emptyWorkingState();
    for (let i = 1; i <= WS_CAPS.logMax + 5; i++) {
      state = apply(state, { logAppend: [`m${i}`] }, i).next;
    }
    expect(state.log.length).toBe(WS_CAPS.logMax);
    // oldest survivor is m6 (m1..m5 fell off)
    expect(state.log[0]?.text).toBe('m6');
    expect(state.log.at(-1)?.text).toBe(`m${WS_CAPS.logMax + 5}`);
  });
});

describe('applyWorkingStatePatch — hypotheses', () => {
  test('add creates an open hypothesis with default source model and returns its id', () => {
    const r = apply(emptyWorkingState(), { hypothesisAdd: { text: 'bug in glob' } }, 7);
    expect(r.createdHypothesisId).toBe('H1');
    expect(r.next.hypotheses[0]).toEqual({
      id: 'H1',
      text: 'bug in glob',
      status: 'open',
      source: 'model',
      evidence: [],
      updatedAtStep: 7,
    });
    expect(r.mutations.hypothesisCreated).toBe(1);
  });

  test('source is honored when provided', () => {
    const r = apply(
      emptyWorkingState(),
      { hypothesisAdd: { text: 'op says X', source: 'user' } },
      1,
    );
    expect(r.next.hypotheses[0]?.source).toBe('user');
  });

  test('over the open cap, the most stale (smallest updatedAtStep) is evicted to the log', () => {
    const gen = idGen();
    let state = emptyWorkingState();
    // Seed exactly the cap, each at an increasing step → H1 is the stalest.
    for (let i = 1; i <= WS_CAPS.hypothesesMaxOpen; i++) {
      state = apply(state, { hypothesisAdd: { text: `h${i}` } }, i, gen).next;
    }
    const before = state.hypotheses.map((h) => h.id);
    expect(before).not.toContain(undefined);

    const r = apply(state, { hypothesisAdd: { text: 'newest' } }, 100, gen);
    expect(r.next.hypotheses.length).toBe(WS_CAPS.hypothesesMaxOpen);
    expect(r.next.hypotheses.find((h) => h.id === 'H1')).toBeUndefined(); // stalest evicted
    expect(r.mutations.hypothesisEvicted).toBe(1);
    expect(r.next.log.some((e) => e.text.includes('H1 archived (stale)'))).toBe(true);
  });

  test('confirmed/refuted leaves the active list and becomes a one-line log', () => {
    const added = apply(emptyWorkingState(), { hypothesisAdd: { text: 'is auth' } }, 2);
    const id = added.createdHypothesisId as string;

    const confirmed = apply(added.next, { hypothesisUpdate: { id, status: 'confirmed' } }, 9);
    expect(confirmed.next.hypotheses).toHaveLength(0);
    expect(confirmed.next.log.at(-1)?.text).toBe(`${id} confirmed: is auth`);
    expect(confirmed.mutations.hypothesisConfirmed).toBe(1);
  });

  test('evidence append refreshes staleness and FIFO-caps at evidenceMax', () => {
    const added = apply(emptyWorkingState(), { hypothesisAdd: { text: 'h' } }, 1);
    const id = added.createdHypothesisId as string;
    const many = Array.from({ length: WS_CAPS.evidenceMax + 2 }, (_, i) => `e${i + 1}`);
    const r = apply(added.next, { hypothesisUpdate: { id, evidenceAppend: many } }, 12);
    const h = r.next.hypotheses[0];
    expect(h?.evidence.length).toBe(WS_CAPS.evidenceMax);
    expect(h?.evidence.at(-1)).toBe(`e${WS_CAPS.evidenceMax + 2}`); // newest kept
    expect(h?.updatedAtStep).toBe(12); // staleness refreshed
  });

  test('update against an unknown id is a no-op (tool rejects upstream)', () => {
    const r = apply(
      emptyWorkingState(),
      { hypothesisUpdate: { id: 'H99', status: 'confirmed' } },
      1,
    );
    expect(r.next.hypotheses).toHaveLength(0);
    expect(r.next.log).toHaveLength(0);
  });

  test('does not mutate the input state', () => {
    const base = emptyWorkingState();
    apply(base, { focus: 'x', logAppend: ['y'], hypothesisAdd: { text: 'z' } }, 1);
    expect(base).toEqual(emptyWorkingState());
  });

  test('F1: combined add+update confirms the target before the add can evict it', () => {
    const gen = idGen();
    let state = emptyWorkingState();
    for (let i = 1; i <= WS_CAPS.hypothesesMaxOpen; i++) {
      state = apply(state, { hypothesisAdd: { text: `h${i}` } }, i, gen).next; // H1 stalest
    }
    // Same call: confirm H1 (the eviction candidate) AND add a new one. Without
    // the update-before-add ordering, the add would evict H1 as "stale" and the
    // confirm would silently vanish.
    const r = apply(
      state,
      { hypothesisUpdate: { id: 'H1', status: 'confirmed' }, hypothesisAdd: { text: 'h8' } },
      100,
      gen,
    );
    expect(r.mutations.hypothesisConfirmed).toBe(1);
    expect(r.mutations.hypothesisEvicted).toBe(0);
    expect(r.next.log.some((e) => e.text === 'H1 confirmed: h1')).toBe(true);
    expect(r.next.log.some((e) => e.text.includes('archived (stale)'))).toBe(false);
  });

  test('F1: a combined evidence update refreshes staleness, redirecting eviction off the target', () => {
    const gen = idGen();
    let state = emptyWorkingState();
    for (let i = 1; i <= WS_CAPS.hypothesesMaxOpen; i++) {
      state = apply(state, { hypothesisAdd: { text: `h${i}` } }, i, gen).next; // H1 stalest, H2 next
    }
    const r = apply(
      state,
      { hypothesisUpdate: { id: 'H1', evidenceAppend: ['proof'] }, hypothesisAdd: { text: 'h8' } },
      100,
      gen,
    );
    expect(r.next.hypotheses.find((h) => h.id === 'H1')).toBeDefined(); // touched → survives
    expect(r.next.hypotheses.find((h) => h.id === 'H2')).toBeUndefined(); // now-stalest evicted
    expect(r.mutations.hypothesisEvicted).toBe(1);
  });

  test('F4: clip caps by code points and never splits a surrogate pair', () => {
    const r = apply(emptyWorkingState(), { focus: '😀'.repeat(WS_CAPS.focusMaxChars + 10) }, 1);
    const text = r.next.focus?.text as string;
    const hasLoneSurrogate = [...text].some((cp) => {
      const c = cp.codePointAt(0) ?? 0;
      return c >= 0xd800 && c <= 0xdfff;
    });
    expect(hasLoneSurrogate).toBe(false);
    expect([...text].length).toBeLessThanOrEqual(WS_CAPS.focusMaxChars);
  });
});

describe('formatWorkingState', () => {
  test('empty panel renders nothing (no trace)', () => {
    expect(formatWorkingState(emptyWorkingState(), 10)).toBeUndefined();
  });

  test('renders focus, next, open hypotheses with age, and windowed log', () => {
    const state: WorkingState = {
      focus: { text: 'investigate glob', atStep: 18 },
      next: ['gate each path'],
      log: [
        { text: 'old marker', atStep: 1 },
        { text: 'fresh marker', atStep: 19 },
      ],
      hypotheses: [
        {
          id: 'H2',
          text: 'bug in resolver',
          status: 'open',
          source: 'model',
          evidence: ['engine.ts:798'],
          updatedAtStep: 18,
        },
      ],
    };
    const block = formatWorkingState(state, 20) as string;
    expect(block.startsWith('[working_state]')).toBe(true);
    expect(block).toContain('focus: investigate glob (s.18, 2 steps ago)');
    expect(block).toContain('H2 (model, 2 steps): bug in resolver');
    expect(block).toContain('evidence: engine.ts:798');
    // recency window (W=10 at step 20): step-19 entry shows, step-1 does not
    expect(block).toContain('fresh marker');
    expect(block).not.toContain('old marker');
  });

  test('global byte guard sheds log first when over cap', () => {
    const bigText = 'x'.repeat(WS_CAPS.hypothesisTextMaxChars);
    const hypotheses = Array.from({ length: WS_CAPS.hypothesesMaxOpen }, (_, i) => ({
      id: `H${i + 1}`,
      text: bigText,
      status: 'open' as const,
      source: 'model' as const,
      evidence: [bigText.slice(0, WS_CAPS.evidenceItemMaxChars)],
      updatedAtStep: 100,
    }));
    const log = Array.from({ length: WS_CAPS.logMax }, () => ({
      text: 'L'.repeat(WS_CAPS.logItemMaxChars),
      atStep: 100,
    }));
    const block = formatWorkingState({ next: [], log, hypotheses }, 100) as string;
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(WS_CAPS.globalRenderMaxBytes);
    expect(block).toContain('elided');
  });

  test('F3: byte guard bounds bytes even when hypotheses alone exceed the cap (multibyte)', () => {
    // CJK: 1 UTF-16 unit but 3 UTF-8 bytes per char — the bare block alone blows
    // the byte cap while its UTF-16 length stays well under it (the bug the
    // UTF-16 slice missed).
    const cjk = '日'.repeat(WS_CAPS.hypothesisTextMaxChars);
    const hypotheses = Array.from({ length: WS_CAPS.hypothesesMaxOpen }, (_, i) => ({
      id: `H${i + 1}`,
      text: cjk,
      status: 'open' as const,
      source: 'model' as const,
      evidence: [],
      updatedAtStep: 100,
    }));
    const block = formatWorkingState({ next: [], log: [], hypotheses }, 100) as string;
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(WS_CAPS.globalRenderMaxBytes);
  });

  test('elision notice stays inside the byte cap across the danger band', () => {
    // A heavy log forces elision (full > cap) for every config below. Sweeping
    // evidence length moves the no-log block through the [cap - noticeLen, cap]
    // band — where the elision notice used to be appended AFTER the cap check,
    // so the returned block could overflow by the notice length. Invariant: the
    // returned block never exceeds the cap, notice included.
    const log = Array.from({ length: WS_CAPS.logMax }, () => ({
      text: 'L'.repeat(WS_CAPS.logItemMaxChars),
      atStep: 100,
    }));
    for (let evLen = 0; evLen <= WS_CAPS.evidenceItemMaxChars; evLen++) {
      const hypotheses = Array.from({ length: 4 }, (_, i) => ({
        id: `H${i + 1}`,
        text: 'x'.repeat(WS_CAPS.hypothesisTextMaxChars),
        status: 'open' as const,
        source: 'model' as const,
        evidence: Array.from({ length: WS_CAPS.evidenceMax }, () => 'e'.repeat(evLen)),
        updatedAtStep: 100,
      }));
      const block = formatWorkingState({ next: [], log, hypotheses }, 100) as string;
      expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(WS_CAPS.globalRenderMaxBytes);
    }
  });
});
