// Markdown renderer for the assistant block. The model's prose
// arrives as GitHub-flavored Markdown; this turns it into terminal
// lines (ANSI, no frame margin — `formatPermanent` pads). Markdown
// is a render concern only: the `assistant` PermanentItem keeps the
// raw `text`, and this module is the single place the tree is
// parsed and walked.
//
// `remark` + `remark-gfm` parse to an `mdast` tree; the walk maps
// each node onto the `term.ts` palette primitives. Streaming is out
// of scope here (slice B) — this renders a finished whole document.
// The matching `UI.md` section + §6 evolution land later (see
// `docs/TODO.md` "Markdown rendering").

import type { List, ListItem, PhrasingContent, RootContent, Table, TableRow } from 'mdast';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import wrapAnsi from 'wrap-ansi';
import { type Capabilities, paint, paintMulti, type SgrToken } from '../term.ts';
import { frameWidth } from './frame.ts';
import { visualWidth } from './width.ts';

// Built once — `remark-gfm` registers the table / task-list /
// strikethrough / autolink extensions on the parser.
const parser = remark().use(remarkGfm);

// Apply the active attribute stack to one text run. The walk threads
// `active` instead of nesting `paint()` calls: a nested `paint` emits
// an inner `\x1b[0m` that resets the OUTER attribute too (bold lost
// after an inline-code span inside `**…**`). One `paintMulti` per
// leaf run — self-contained, no nesting.
const styled = (text: string, caps: Capabilities, active: readonly SgrToken[]): string =>
  active.length > 0 ? paintMulti(caps, active, text) : text;

// Inline (phrasing) nodes → a single styled string. `active` carries
// the attribute stack down so each leaf run paints itself whole.
const renderInline = (
  nodes: readonly PhrasingContent[],
  caps: Capabilities,
  active: readonly SgrToken[] = [],
): string => {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += styled(node.value, caps, active);
        break;
      case 'strong':
        out += renderInline(node.children, caps, [...active, 'bold']);
        break;
      case 'emphasis':
        out += renderInline(node.children, caps, [...active, 'italic']);
        break;
      case 'delete':
        out += renderInline(node.children, caps, [...active, 'strikethrough']);
        break;
      case 'inlineCode':
        // `accent` (blue): inline code is the prose's most frequent
        // technical anchor — flags, paths, identifiers — and blue
        // lifts it off the greyscale. Reuses the chrome token for
        // now; the §6 alignment revisits accent-vs-own-token.
        out += styled(node.value, caps, [...active, 'accent']);
        break;
      case 'break':
        out += '\n';
        break;
      case 'image':
        out += styled(node.alt ?? '', caps, active);
        break;
      case 'link': {
        // The URL rides inline, dimmed — only when it adds info (an
        // autolink has label === url). The match is against the RAW
        // label text, not the styled one: surrounding formatting (a
        // link inside **…**) adds SGR that would make an equal URL
        // compare unequal. OSC 8 hyperlinks are a UI.md §13 non-goal.
        const label = renderInline(node.children, caps, active);
        const rawLabel = renderInline(node.children, { ...caps, color: 'none' }, []);
        out +=
          node.url !== '' && node.url !== rawLabel
            ? `${label} ${styled(`(${node.url})`, caps, [...active, 'dim'])}`
            : label;
        break;
      }
      default: {
        // Any other phrasing node (linkReference, footnoteReference,
        // inline html): render its children, or a raw value if leaf.
        const other = node as { children?: PhrasingContent[]; value?: string };
        if (other.children !== undefined) out += renderInline(other.children, caps, active);
        else if (typeof other.value === 'string') out += styled(other.value, caps, active);
        break;
      }
    }
  }
  return out;
};

// Word-wrap a styled string to `width`, honoring existing newlines
// (hard breaks). Width ≤ 0 (deep nesting in a narrow terminal) just
// splits on newlines without wrapping.
const wrapText = (text: string, width: number): string[] =>
  width > 0 ? wrapAnsi(text, width).split('\n') : text.split('\n');

const listMarker = (node: List, item: ListItem, n: number, caps: Capabilities): string => {
  if (item.checked === true) return '[x] ';
  if (item.checked === false) return '[ ] ';
  if (node.ordered === true) return `${n}. `;
  return caps.unicode ? '• ' : '- ';
};

// GFM table. Columns are measured; if the aligned grid fits the
// available width it renders as a grid (bold header + rule + padded
// rows), otherwise it degrades to a stack — one `header: value`
// block per data row, which fits any width (UI.md §4.11).
const renderTable = (node: Table, caps: Capabilities, width: number, indent: number): string[] => {
  const pad = ' '.repeat(indent);
  const avail = Math.max(1, width - indent);
  const headerNode = node.children[0];
  if (headerNode === undefined) return [];
  const bodyNodes = node.children.slice(1);

  // Render a row's cells with an attribute stack — `active` threads
  // the style through `renderInline`, so a header cell with inline
  // markup keeps its style across the markup's own SGR resets (no
  // `paint` wrapping after the fact).
  const cellsOf = (row: TableRow, active: readonly SgrToken[]): string[] =>
    row.children.map((cell) => renderInline(cell.children, caps, active));

  const header = cellsOf(headerNode, []);
  const body = bodyNodes.map((row) => cellsOf(row, []));
  const cols = header.length;

  // Column width = the visual max over every row (style-independent).
  const colWidth = Array.from({ length: cols }, (_, c) =>
    Math.max(visualWidth(header[c] ?? ''), ...body.map((row) => visualWidth(row[c] ?? ''))),
  );
  const SEP = '  ';
  const gridWidth = colWidth.reduce((a, b) => a + b, 0) + SEP.length * Math.max(0, cols - 1);

  const padTo = (text: string, w: number): string =>
    text + ' '.repeat(Math.max(0, w - visualWidth(text)));
  // Every column but the last is padded — no trailing margin (§6.3).
  const gridRow = (cells: string[]): string =>
    pad + cells.map((cell, c) => (c === cols - 1 ? cell : padTo(cell, colWidth[c] ?? 0))).join(SEP);

  // Grid — the aligned table fits the available width.
  if (gridWidth <= avail) {
    const out = [gridRow(cellsOf(headerNode, ['bold']))];
    const ruleGlyph = caps.unicode ? '─' : '-';
    out.push(pad + paint(caps, 'dim', ruleGlyph.repeat(Math.min(gridWidth, avail))));
    for (const row of body) out.push(gridRow(row));
    return out;
  }

  // Stack — degrade to a width-independent layout. A header-only
  // table (no data rows) lists its column headers one per line; a
  // table with data rows emits one `header: value` block per row.
  // Label = the column header, dimmed.
  const labels = cellsOf(headerNode, ['secondary']);
  const colon = paint(caps, 'secondary', ':');
  const out: string[] = [];
  if (body.length === 0) {
    for (const label of labels) {
      for (const line of wrapText(label, avail)) out.push(pad + line);
    }
    return out;
  }
  body.forEach((row, i) => {
    if (i > 0) out.push('');
    labels.forEach((label, c) => {
      for (const line of wrapText(`${label}${colon} ${row[c] ?? ''}`, avail)) out.push(pad + line);
    });
  });
  return out;
};

// A list: each item's content is flow, rendered at `indent +
// marker.length`; the item's first line swaps that indent for the
// marker so the bullet sits flush and continuation lines align.
const renderList = (node: List, caps: Capabilities, width: number, indent: number): string[] => {
  const out: string[] = [];
  let n = node.start ?? 1;
  for (const item of node.children) {
    const marker = listMarker(node, item, n, caps);
    n += 1;
    const childIndent = indent + marker.length;
    // Item content is rendered block-by-block with NO blank line
    // between — list items read tight (the common LLM case); a
    // loose item with two paragraphs accepts the lost breather.
    const inner: string[] = [];
    for (const child of item.children) {
      inner.push(...renderBlock(child, caps, width, childIndent));
    }
    if (inner.length === 0) {
      out.push(' '.repeat(indent) + marker);
      continue;
    }
    inner.forEach((line, j) => {
      out.push(j === 0 ? ' '.repeat(indent) + marker + line.slice(childIndent) : line);
    });
  }
  return out;
};

// One block node → its terminal lines, each prefixed with `indent`
// spaces (the invariant `renderList` relies on to place markers).
const renderBlock = (
  node: RootContent,
  caps: Capabilities,
  width: number,
  indent: number,
): string[] => {
  const pad = ' '.repeat(indent);
  switch (node.type) {
    case 'paragraph':
      return wrapText(renderInline(node.children, caps), width - indent).map((l) => pad + l);
    case 'heading':
      return wrapText(renderInline(node.children, caps, ['bold']), width - indent).map(
        (l) => pad + l,
      );
    case 'code':
      // Indented two columns, dim. No syntax highlighting — that
      // fights the §6.1 palette; deferred (docs/TODO.md).
      return node.value.split('\n').map((l) => `${pad}  ${paint(caps, 'dim', l)}`);
    case 'blockquote': {
      const bar = paint(caps, 'secondary', caps.unicode ? '│ ' : '| ');
      return renderFlow(node.children, caps, Math.max(1, width - indent - 2), 0).map(
        (l) => pad + bar + l,
      );
    }
    case 'thematicBreak':
      return [
        pad + paint(caps, 'dim', (caps.unicode ? '─' : '-').repeat(Math.max(0, width - indent))),
      ];
    case 'list':
      return renderList(node, caps, width, indent);
    case 'table':
      return renderTable(node, caps, width, indent);
    default:
      // html / definition / footnoteDefinition — render a raw `value`
      // if present (rare in LLM prose), else skip.
      if ('value' in node && typeof node.value === 'string') {
        return node.value.split('\n').map((l) => pad + l);
      }
      return [];
  }
};

// A sequence of block nodes → lines, one blank line between blocks.
const renderFlow = (
  nodes: readonly RootContent[],
  caps: Capabilities,
  width: number,
  indent: number,
): string[] => {
  const out: string[] = [];
  for (const node of nodes) {
    const block = renderBlock(node, caps, width, indent);
    if (block.length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(...block);
  }
  return out;
};

// Render a Markdown document to terminal lines — no frame margin, the
// caller pads. Empty input → no lines.
export const renderMarkdown = (src: string, caps: Capabilities): string[] => {
  const tree = parser.parse(src);
  return renderFlow(tree.children, caps, frameWidth(caps), 0);
};
