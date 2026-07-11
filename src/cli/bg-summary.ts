// Compact head-tail of a finished bg process's output, for the inline
// bg_done notification. Extracted from the repl so the byte-offset math
// (the part that has bitten us twice — real-tail, then multibyte cursors)
// is unit-testable against a stubbed reader instead of a live process.

import type { BgManager } from '../bg/index.ts';

const BG_SUMMARY_HEAD = 500;
const BG_SUMMARY_TAIL = 2000;

// The only manager surface this needs. Narrowing to `readOutput` keeps the
// unit test a one-method stub rather than a full BgManager.
export type BgSummaryReader = Pick<BgManager, 'readOutput'>;

// Build a compact head-tail of a finished process's output. The TAIL is the
// REAL end of the stream (not the end of a leading window) — so a multi-MB
// run still surfaces the failures at the bottom. First read gets the heads +
// `pending` counts (→ totals); a second read fetches the true tail of each
// stream when there is one. Two small reads, observational (since:* does not
// advance the persisted cursor). Undefined when the process was silent.
export const buildBgSummary = async (
  mgr: BgSummaryReader,
  processId: string,
): Promise<string | undefined> => {
  const lead = await mgr.readOutput(processId, {
    sinceStdout: 0,
    sinceStderr: 0,
    maxBytes: BG_SUMMARY_HEAD,
  });
  // Totals must be in BYTES: `stdoutPending` and the `since*` offsets the bg
  // manager speaks are byte offsets, but `lead.stdout.length` is JS code
  // units — it undercounts whenever the head holds multibyte UTF-8. An
  // undercount anchors the tail read too early, so `maxBytes: BG_SUMMARY_TAIL`
  // can stop short of EOF and drop the very last lines — exactly the failure
  // tail bg_done exists to surface. `stdoutCursor` is the byte offset just
  // past the head slice, so cursor + pending is the true byte length.
  const stdoutTotal = lead.stdoutCursor + lead.stdoutPending;
  const stderrTotal = lead.stderrCursor + lead.stderrPending;
  let tailStdout = '';
  let tailStderr = '';
  if (stdoutTotal > BG_SUMMARY_HEAD || stderrTotal > BG_SUMMARY_HEAD) {
    const tail = await mgr.readOutput(processId, {
      sinceStdout: Math.max(0, stdoutTotal - BG_SUMMARY_TAIL),
      sinceStderr: Math.max(0, stderrTotal - BG_SUMMARY_TAIL),
      maxBytes: BG_SUMMARY_TAIL,
    });
    tailStdout = tail.stdout;
    tailStderr = tail.stderr;
  }
  // Per-stream: head is everything (small); the tail read at since:0 is
  // everything (total <= TAIL); else head + tail, with an elision marker
  // (large) or a bare "…" when the two nearly meet — never drop the start.
  const combine = (head: string, total: number, tail: string): string => {
    if (total <= BG_SUMMARY_HEAD) return head.trim();
    if (total <= BG_SUMMARY_TAIL) return tail.trim(); // tail (since:0) is the whole stream
    const elided = total - BG_SUMMARY_HEAD - BG_SUMMARY_TAIL;
    const marker = elided > 0 ? `… [${elided} bytes elided — bash_output for full] …` : '…';
    return `${head.trim()}\n${marker}\n${tail.trim()}`;
  };
  const parts: string[] = [];
  const out = combine(lead.stdout, stdoutTotal, tailStdout);
  const err = combine(lead.stderr, stderrTotal, tailStderr);
  if (out.length > 0) parts.push(out);
  if (err.length > 0) parts.push(`[stderr]\n${err}`);
  return parts.length > 0 ? parts.join('\n') : undefined;
};
