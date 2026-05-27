// Deterministic output-summarization helpers. Tools whose `execute`
// can return tens of KB of text attach `metadata.summarize` (see
// `tools/types.ts`); the helpers below are the building blocks each
// tool's summarizer composes.
//
// Why deterministic and not LLM-driven: summarization runs on every
// tool call where the output crosses a threshold. An LLM round-trip
// would add latency + cost to every grep / bash hit. Head-tail and
// group-by-file capture > 90% of the bytes a verbose LLM summary
// would also drop, with no provider call. A future Tier 2 (Haiku
// summarizer) can sit alongside for cases where deterministic cuts
// lose load-bearing signal.
//
// Pure functions only — no I/O, no time-dependence. The harness
// replay path re-executes summarizers against the raw audit row,
// so any non-determinism would surface as a divergent replay.

// Default head/tail line count for the head-tail summarizer. Each
// tool sets its own byte threshold (bash uses 16 KB, glob uses an
// item-count threshold) but the line count converges on the same
// reading shape: ~80 lines top + ~80 lines bottom leaves enough
// context for the model to recover the gist without re-querying.
export const HEAD_TAIL_DEFAULT_LINES = 80;

export interface HeadTailOptions {
  // Byte threshold. Inputs at or below this length pass through
  // unchanged; above it, the helper takes `headLines` from the top
  // and `tailLines` from the bottom and inserts an elision marker
  // with the dropped byte count between them.
  maxBytes: number;
  headLines: number;
  tailLines: number;
}

export interface TextSummary {
  text: string;
  reduced: boolean;
  // Pre-summary byte length of the input — caller composes
  // multiple summaries (e.g., stdout + stderr) and reports the
  // total in the SummarizedOutput.originalBytes field.
  originalBytes: number;
}

const splitLines = (s: string): string[] => {
  if (s.length === 0) return [];
  const lines = s.split('\n');
  // A trailing newline produces a phantom empty tail entry. Drop
  // it so head/tail counts reflect real content lines.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

// Head-tail policy: when input exceeds `maxBytes`, keep the first
// `headLines` and the last `tailLines`; replace the middle with
// `[... N lines elided (Mb dropped) ...]`. Below the threshold,
// passes through unchanged.
//
// Used by bash (stdout / stderr each) and glob (matches array).
export const headTailSummary = (text: string, opts: HeadTailOptions): TextSummary => {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= opts.maxBytes) {
    return { text, reduced: false, originalBytes };
  }
  const lines = splitLines(text);
  // When the input is huge in bytes but few in lines (one giant
  // line, e.g. a base64 blob), head + tail by line count won't
  // reduce. Fall back to a byte-window: keep the first ~half of
  // maxBytes and the last ~half, with the elision marker between.
  if (lines.length <= opts.headLines + opts.tailLines) {
    const halfBudget = Math.floor(opts.maxBytes / 2);
    const head = text.slice(0, halfBudget);
    const tail = text.slice(text.length - halfBudget);
    const dropped =
      originalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
    return {
      text: `${head}\n[... ${formatBytes(dropped)} dropped ...]\n${tail}`,
      reduced: true,
      originalBytes,
    };
  }
  const head = lines.slice(0, opts.headLines).join('\n');
  const tail = lines.slice(lines.length - opts.tailLines).join('\n');
  const elidedLineCount = lines.length - opts.headLines - opts.tailLines;
  const elidedBytes =
    originalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  return {
    text: `${head}\n[... ${elidedLineCount} lines elided (${formatBytes(elidedBytes)} dropped) ...]\n${tail}`,
    reduced: true,
    originalBytes,
  };
};

// Compact byte-count rendering for elision markers. Mirrors the
// "human size" convention readers expect: B / KB / MB. Avoids
// fixed-decimals when the count rounds cleanly (so `1024` reads
// `1KB`, not `1.0KB`).
const formatBytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    const rounded = Math.round(kb * 10) / 10;
    return rounded === Math.floor(rounded) ? `${rounded.toFixed(0)}KB` : `${rounded.toFixed(1)}KB`;
  }
  const mb = n / (1024 * 1024);
  const rounded = Math.round(mb * 10) / 10;
  return rounded === Math.floor(rounded) ? `${rounded.toFixed(0)}MB` : `${rounded.toFixed(1)}MB`;
};
