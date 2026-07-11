// Dependency-free HTML → Markdown converter for the `fetch_url` tool.
//
// Parsing is delegated to Bun's built-in `HTMLRewriter` (Cloudflare's
// lol-html, a streaming HTML5 parser compiled into the runtime): no
// new dependency, no fragile hand-rolled tokenizer, and raw-text
// elements (`<script>`/`<style>`) are handled correctly so a `</p>`
// inside a script string literal can't desync the tag stream. We own
// only the *emission* — a small state machine that walks the parser's
// open/text/close event stream and renders markdown. The locked stack
// hand-rolls the TUI and storage layer; pulling an npm HTML library in
// for one tool would widen the supply-chain surface a security-minded
// agent deliberately keeps narrow, so HTMLRewriter is the sweet spot.
//
// Coverage: headings, paragraphs, links, images, ordered/unordered
// lists (nested), blockquotes, `pre`/`code` (fenced + inline),
// `strong`/`em`/`del`, `hr`, `br`, and GFM tables. `script`/`style`/
// `noscript`/`textarea` and `svg`/`iframe`/`object`/`canvas`/
// `template`/`math` subtrees are dropped. Unknown tags degrade to
// their text content — the goal is "never lose the readable words",
// not "round-trip the DOM".

interface OpenToken {
  type: 'open';
  tag: string;
  attrs: Record<string, string>;
}
interface TextToken {
  type: 'text';
  value: string;
}
interface CloseToken {
  type: 'close';
  tag: string;
}
type Token = OpenToken | TextToken | CloseToken;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  deg: '°',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  cent: '¢',
  sect: '§',
  para: '¶',
};

// Decode HTML entities — named (common subset above) and numeric
// (decimal `&#169;` + hex `&#xA9;`). Unknown entities pass through
// verbatim. Bun's HTMLRewriter does not decode entities in text /
// attribute chunks, so this runs on everything we surface.
export const decodeEntities = (input: string): string => {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
};

// Subtrees dropped wholesale: their bodies are either non-prose
// (script/style), form noise (textarea), or structurally HTML but
// carrying nothing a reader wants (svg/iframe/...). `title` is dropped
// from the BODY stream but captured separately (see tokenize) so it
// can become the document's leading H1.
const DROP_SUBTREES = new Set([
  'script',
  'style',
  'noscript',
  'textarea',
  'title',
  'svg',
  'iframe',
  'object',
  'canvas',
  'template',
  'math',
]);

// Void elements have no end tag — `onEndTag` throws on them, so we
// skip registering a close and let the walker handle them on open.
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// Drive HTMLRewriter over the document and flatten its event stream
// into an ordered open/text/close token list, plus the page `<title>`.
const tokenize = async (html: string): Promise<{ tokens: Token[]; title: string }> => {
  const tokens: Token[] = [];
  let title = '';

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(chunk) {
        title += chunk.text;
      },
    })
    .on('*', {
      element(el) {
        const tag = el.tagName.toLowerCase();
        const attrs: Record<string, string> = {};
        // Only the attributes the emitter actually consumes — keeps
        // the token small and avoids iterating the full attr list.
        if (tag === 'a') {
          const href = el.getAttribute('href');
          if (href !== null) attrs.href = decodeEntities(href);
        } else if (tag === 'img') {
          attrs.src = decodeEntities(el.getAttribute('src') ?? '');
          attrs.alt = decodeEntities(el.getAttribute('alt') ?? '');
        }
        tokens.push({ type: 'open', tag, attrs });
        if (!VOID_ELEMENTS.has(tag)) {
          // onEndTag fires at the actual close in document order; for
          // implied-close elements (`<li>` without `</li>`) lol-html
          // stacks the callbacks at the parent close, which the
          // walker tolerates (a new block-open flushes the previous).
          try {
            el.onEndTag(() => {
              tokens.push({ type: 'close', tag });
            });
          } catch {
            // Element type that rejects onEndTag — treat as void.
          }
        }
      },
      text(chunk) {
        if (chunk.text.length > 0) tokens.push({ type: 'text', value: chunk.text });
      },
    });

  // `transform` is lazy — consume the response body to drive the
  // handlers to completion.
  await rewriter.transform(new Response(html)).arrayBuffer();
  return { tokens, title: decodeEntities(title).replace(/\s+/g, ' ').trim() };
};

// Inline frame: a span of text accumulated for an inline wrapping
// element (a/strong/em/code). The root frame of a block holds the
// block's text; child frames wrap on close and fold into the parent.
interface Frame {
  tag: string;
  attrs: Record<string, string>;
  buf: string;
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'figure',
  'figcaption',
  'address',
  'form',
  'fieldset',
  'dl',
  'dt',
  'dd',
]);
const INLINE_TAGS = new Set([
  'a',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'del',
  's',
  'strike',
  'span',
  'small',
  'sub',
  'sup',
  'u',
  'mark',
  'abbr',
  'cite',
  'q',
  'time',
  'label',
]);

const collapseWs = (s: string): string => s.replace(/\s+/g, ' ');

// URL schemes that can smuggle executable code into a rendered link or image
// — `javascript:`, `data:`, `vbscript:` (CWE-184). Before testing the scheme
// we normalize the way a URL parser would: strip control chars + whitespace
// (so `java\tscript:`, ` data:`, or a decoded `&#1;javascript:` can't slip
// past a naive prefix match) and lowercase. Matching only `javascript:` — the
// prior check — left `data:text/html,<script>…` and `vbscript:` open.
const UNSAFE_URL_SCHEMES = ['javascript:', 'data:', 'vbscript:'] as const;
const hasUnsafeScheme = (url: string): boolean => {
  const normalized = url.replace(/[\p{Cc}\s]/gu, '').toLowerCase();
  return UNSAFE_URL_SCHEMES.some((scheme) => normalized.startsWith(scheme));
};

// Wrap an inline frame's buffer per its tag once it closes.
const wrapInline = (frame: Frame): string => {
  const text = frame.buf;
  const empty = text.trim().length === 0;
  switch (frame.tag) {
    case 'a': {
      const href = frame.attrs.href ?? '';
      const label = empty ? href : text;
      if (href.length === 0 || hasUnsafeScheme(href)) return text;
      return `[${label}](${href})`;
    }
    case 'strong':
    case 'b':
      return empty ? text : `**${text}**`;
    case 'em':
    case 'i':
      return empty ? text : `*${text}*`;
    case 'code': {
      if (empty) return text;
      // GFM: wrap in a backtick fence longer than the longest run inside,
      // padding with a space when the content touches a backtick — so code
      // that literally contains backticks survives instead of being stripped.
      const longest = (text.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
      const fence = '`'.repeat(longest + 1);
      const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
      return `${fence}${pad}${text}${pad}${fence}`;
    }
    case 'del':
    case 's':
    case 'strike':
      return empty ? text : `~~${text}~~`;
    default:
      return text;
  }
};

interface ListCtx {
  ordered: boolean;
  index: number;
}

// Walk the token stream and emit markdown blocks.
const walk = (tokens: Token[], title: string): string => {
  // Each block carries a `run` id: 0 for standalone blocks, or a
  // positive id shared by every item of one top-level list. Adjacent
  // blocks with the same non-zero run join tight (single newline —
  // markdown list semantics); everything else gets a blank line.
  const blocks: { text: string; run: number }[] = [];
  const emit = (text: string, run = 0): void => {
    blocks.push({ text, run });
  };
  let frames: Frame[] = [{ tag: '#root', attrs: {}, buf: '' }];
  const lists: ListCtx[] = [];
  let listRunId = 0;
  let curRun = 0;
  // True while the current <li> still owes its marker. The marker is
  // emitted on the FIRST non-empty block of the item; further blocks in the
  // same item become continuation lines (indented, no new marker) instead of
  // spawning duplicate "- "/"1." entries.
  let liMarkerPending = false;
  let dropDepth = 0;
  let preDepth = 0;
  let blockquoteDepth = 0;
  let sawHeading = false;
  let tableRows: string[][] | null = null;
  let tableCell: string | null = null;

  // frames always holds the root frame, so the index is never out of
  // bounds — assert past noUncheckedIndexedAccess.
  const top = (): Frame => frames[frames.length - 1] as Frame;

  const pushText = (value: string): void => {
    if (dropDepth > 0) return;
    const decoded = decodeEntities(value);
    if (preDepth > 0) {
      top().buf += decoded;
      return;
    }
    const collapsed = collapseWs(decoded);
    if (collapsed.length === 0) return;
    const buf = top().buf;
    if (buf.length === 0 && collapsed === ' ') return;
    if (buf.endsWith(' ') && collapsed.startsWith(' ')) {
      top().buf += collapsed.slice(1);
    } else {
      top().buf += collapsed;
    }
  };

  const listPrefix = (): string => {
    if (lists.length === 0) return '';
    const indent = '  '.repeat(lists.length - 1);
    const cur = lists[lists.length - 1];
    if (cur === undefined) return '';
    return cur.ordered ? `${indent}${cur.index}. ` : `${indent}- `;
  };

  // Flush the current block buffer (paragraph / list item / blockquote
  // line, per context) and reset the frame stack.
  const flush = (opts: { heading?: number } = {}): void => {
    while (frames.length > 1) {
      const f = frames.pop() as Frame;
      top().buf += wrapInline(f);
    }
    let text = (frames[0] as Frame).buf;
    frames = [{ tag: '#root', attrs: {}, buf: '' }];
    if (preDepth === 0) text = text.replace(/[ \t]+\n/g, '\n').trim();
    if (text.length === 0) return;
    if (opts.heading !== undefined) {
      emit(`${'#'.repeat(opts.heading)} ${text}`);
      return;
    }
    const inList = lists.length > 0;
    let line: string;
    if (inList) {
      const prefix = listPrefix();
      if (liMarkerPending) {
        line = prefix + text;
        liMarkerPending = false;
      } else {
        // Continuation block within the same item: align under the marker.
        line = ' '.repeat(prefix.length) + text;
      }
    } else {
      line = text;
    }
    if (blockquoteDepth > 0) {
      line = line
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    }
    emit(line, inList ? curRun : 0);
  };

  for (const t of tokens) {
    if (t.type === 'text') {
      if (tableCell !== null) tableCell += collapseWs(decodeEntities(t.value));
      else pushText(t.value);
      continue;
    }

    if (t.type === 'open') {
      const tag = t.tag;
      if (dropDepth > 0) {
        if (DROP_SUBTREES.has(tag)) dropDepth++;
        continue;
      }
      if (DROP_SUBTREES.has(tag)) {
        dropDepth++;
        continue;
      }
      if (INLINE_TAGS.has(tag)) {
        // Inside <pre>, content is verbatim — don't open an inline
        // frame (a `<code>` child would otherwise get backtick-wrapped
        // AND fenced). Treat as transparent.
        if (preDepth === 0) frames.push({ tag, attrs: t.attrs, buf: '' });
        continue;
      }
      if (tag === 'br') {
        if (tableCell !== null) tableCell += ' ';
        else top().buf += preDepth > 0 ? '\n' : '  \n';
        continue;
      }
      if (tag === 'hr') {
        flush();
        emit('---');
        continue;
      }
      if (tag === 'img') {
        const src = t.attrs.src ?? '';
        const alt = t.attrs.alt ?? '';
        // Drop an unsafe-scheme src (javascript:/data:/vbscript:) the same way
        // links do — a `data:` blob is also pure token noise for the model, so
        // falling back to alt text is doubly correct.
        if (src.length > 0 && !hasUnsafeScheme(src)) top().buf += `![${alt}](${src})`;
        else if (alt.length > 0) top().buf += alt; // keep alt text when src is absent/unsafe
        continue;
      }
      if (HEADINGS.has(tag)) {
        flush();
        sawHeading = true;
        continue;
      }
      if (tag === 'pre') {
        flush();
        preDepth++;
        continue;
      }
      if (tag === 'blockquote') {
        flush();
        blockquoteDepth++;
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        flush();
        if (lists.length === 0) {
          listRunId++;
          curRun = listRunId;
        }
        lists.push({ ordered: tag === 'ol', index: 1 });
        continue;
      }
      if (tag === 'li') {
        flush();
        liMarkerPending = true;
        continue;
      }
      if (tag === 'table') {
        flush();
        tableRows = [];
        continue;
      }
      if (tag === 'tr') {
        if (tableRows !== null) tableRows.push([]);
        continue;
      }
      if (tag === 'td' || tag === 'th') {
        if (tableRows !== null) tableCell = '';
        continue;
      }
      if (BLOCK_TAGS.has(tag)) flush();
      continue;
    }

    // close
    const tag = t.tag;
    if (dropDepth > 0) {
      if (DROP_SUBTREES.has(tag)) dropDepth--;
      continue;
    }
    if (INLINE_TAGS.has(tag)) {
      let idx = -1;
      for (let f = frames.length - 1; f >= 1; f--) {
        if ((frames[f] as Frame).tag === tag) {
          idx = f;
          break;
        }
      }
      if (idx !== -1) {
        while (frames.length - 1 > idx) {
          const f = frames.pop() as Frame;
          top().buf += wrapInline(f);
        }
        const matched = frames.pop() as Frame;
        top().buf += wrapInline(matched);
      }
      continue;
    }
    if (HEADINGS.has(tag)) {
      flush({ heading: Number.parseInt(tag.slice(1), 10) });
      continue;
    }
    if (tag === 'pre') {
      while (frames.length > 1) {
        const f = frames.pop() as Frame;
        top().buf += wrapInline(f);
      }
      const raw = (frames[0] as Frame).buf.replace(/\n+$/, '').replace(/^\n+/, '');
      frames = [{ tag: '#root', attrs: {}, buf: '' }];
      preDepth = Math.max(0, preDepth - 1);
      if (raw.length > 0) emit(`\`\`\`\n${raw}\n\`\`\``);
      continue;
    }
    if (tag === 'blockquote') {
      flush();
      blockquoteDepth = Math.max(0, blockquoteDepth - 1);
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      lists.pop();
      if (lists.length === 0) {
        curRun = 0;
        liMarkerPending = false;
      }
      continue;
    }
    if (tag === 'li') {
      flush();
      const cur = lists[lists.length - 1];
      if (cur?.ordered) cur.index++;
      continue;
    }
    if (tag === 'td' || tag === 'th') {
      if (tableRows !== null && tableCell !== null) {
        const row = tableRows[tableRows.length - 1];
        if (row !== undefined) row.push(tableCell.trim());
      }
      tableCell = null;
      continue;
    }
    if (tag === 'table') {
      if (tableRows !== null) emit(renderTable(tableRows));
      tableRows = null;
      continue;
    }
    if (BLOCK_TAGS.has(tag)) flush();
  }
  flush();

  const kept = blocks.filter((b) => b.text.length > 0);
  let body = '';
  for (let i = 0; i < kept.length; i++) {
    const cur = kept[i] as { text: string; run: number };
    if (i > 0) {
      const prev = kept[i - 1] as { text: string; run: number };
      const tight = cur.run !== 0 && cur.run === prev.run;
      body += tight ? '\n' : '\n\n';
    }
    body += cur.text;
  }
  // Prepend the page title as an H1 when the document had no heading
  // of its own — gives the model a label for what it fetched.
  if (!sawHeading && title.length > 0) body = `# ${title}\n\n${body}`;
  return `${body.replace(/\n{3,}/g, '\n\n').trim()}\n`;
};

// Render a collected table as a GFM table. The first row is the
// header; ragged rows are padded to the widest.
const renderTable = (rows: string[][]): string => {
  const cleaned = rows.filter((r) => r.length > 0);
  if (cleaned.length === 0) return '';
  const cols = Math.max(...cleaned.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    const copy = r.slice();
    while (copy.length < cols) copy.push('');
    return copy.map((c) => c.replace(/\|/g, '\\|'));
  };
  const header = pad(cleaned[0] as string[]);
  const out = [`| ${header.join(' | ')} |`, `| ${new Array(cols).fill('---').join(' | ')} |`];
  for (let r = 1; r < cleaned.length; r++)
    out.push(`| ${pad(cleaned[r] as string[]).join(' | ')} |`);
  return out.join('\n');
};

// Convert an HTML document (or fragment) to Markdown. Returns a
// trimmed markdown string ending in a single newline. Never throws on
// malformed input — degrades to extracted text.
export const htmlToMarkdown = async (html: string): Promise<string> => {
  if (html.length === 0) return '';
  try {
    const { tokens, title } = await tokenize(html);
    return walk(tokens, title);
  } catch {
    // Last-resort fallback: strip tags, decode entities, collapse.
    const stripped = decodeEntities(html.replace(/<[^>]*>/g, ' '));
    return `${stripped.replace(/\s+/g, ' ').trim()}\n`;
  }
};
