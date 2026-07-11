import { describe, expect, test } from 'bun:test';
import { decodeEntities, htmlToMarkdown } from '../../src/tools/builtin/_html-to-markdown.ts';

describe('decodeEntities', () => {
  test('named, numeric decimal, and hex entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#169; &#xA9;')).toBe('a & b <c> © ©');
    // &nbsp; is normalized to a regular space (a non-breaking space would
    // render awkwardly in markdown).
    expect(decodeEntities('x&nbsp;y')).toBe('x y');
  });
  test('unknown entity passes through verbatim', () => {
    expect(decodeEntities('&bogus; &amp;')).toBe('&bogus; &');
  });
  test('no ampersand short-circuits', () => {
    expect(decodeEntities('plain text')).toBe('plain text');
  });
});

describe('htmlToMarkdown', () => {
  test('headings and inline formatting', async () => {
    const md = await htmlToMarkdown(
      '<h1>Title</h1><h2>Sub</h2><p>A <b>bold</b> and <em>italic</em> and <code>x()</code>.</p>',
    );
    expect(md).toContain('# Title');
    expect(md).toContain('## Sub');
    expect(md).toContain('A **bold** and *italic* and `x()`.');
  });

  test('links render as markdown with decoded href', async () => {
    const md = await htmlToMarkdown('<p>see <a href="https://x.com/a?b=1&amp;c=2">here</a></p>');
    expect(md).toContain('[here](https://x.com/a?b=1&c=2)');
  });

  test('unsafe-scheme links (javascript:/data:/vbscript:) are not linkified', async () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      // Bypasses a browser would still execute — mixed case, a leading space,
      // and an embedded tab — must be neutralized by the same normalization.
      'JavaScript:alert(1)',
      '  data:text/html,x',
      'java\tscript:alert(1)',
    ]) {
      const md = await htmlToMarkdown(`<a href="${href}">click</a>`);
      expect(md).toContain('click'); // the label text survives
      expect(md).not.toContain(']('); // …but it is never emitted as a link
    }
  });

  test('images render as markdown; an unsafe/data src falls back to alt text', async () => {
    // A normal image round-trips to markdown.
    expect(await htmlToMarkdown('<img src="https://x.com/a.png" alt="pic">')).toContain(
      '![pic](https://x.com/a.png)',
    );
    // javascript:/data: srcs never reach the output as an image target; the
    // alt text is kept instead.
    for (const src of ['javascript:alert(1)', 'data:text/html,<script>x</script>']) {
      const md = await htmlToMarkdown(`<img src="${src}" alt="safe label">`);
      expect(md).toContain('safe label');
      expect(md).not.toContain('](');
    }
  });

  test('nested unordered + ordered lists are tight', async () => {
    const md = await htmlToMarkdown(
      '<ul><li>one<li>two<ul><li>nested</ul></ul><ol><li>a</li><li>b</li></ol>',
    );
    expect(md).toContain('- one\n- two\n  - nested');
    expect(md).toContain('1. a\n2. b');
    // The two lists are distinct → separated by a blank line.
    expect(md).toContain('nested\n\n1. a');
  });

  test('pre/code becomes a fenced block without inline backticks', async () => {
    const md = await htmlToMarkdown('<pre><code>const x = 1;\nconst y = 2;</code></pre>');
    expect(md).toContain('```\nconst x = 1;\nconst y = 2;\n```');
    expect(md).not.toContain('`const x');
  });

  test('blockquote prefixes lines', async () => {
    const md = await htmlToMarkdown('<blockquote>quoted</blockquote>');
    expect(md).toContain('> quoted');
  });

  test('tables render as GFM', async () => {
    const md = await htmlToMarkdown(
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
  });

  test('table cells escape both pipe and backslash so a row cannot break (GFM)', async () => {
    const BS = '\\'; // a single literal backslash — avoids counting source escapes
    const md = await htmlToMarkdown(
      `<table><tr><th>a|b</th></tr><tr><td>x${BS}|y</td></tr></table>`,
    );
    // The pipe is escaped so it is not read as a column delimiter…
    expect(md).toContain(`a${BS}|b`);
    // …and a literal backslash-before-pipe is FULLY escaped (\\ then \|), not
    // left as `\` + an unescaped `|` that would split the row into two columns.
    expect(md).toContain(`x${BS}${BS}${BS}|y`);
  });

  test('script/style content is dropped, never leaked', async () => {
    const md = await htmlToMarkdown(
      '<style>.a{color:red}</style><p>visible</p><script>var s = "</p><h1>injected</h1>";</script>',
    );
    expect(md).toContain('visible');
    expect(md).not.toContain('injected');
    expect(md).not.toContain('color:red');
  });

  test('title becomes the leading H1 when no heading exists', async () => {
    const md = await htmlToMarkdown(
      '<head><title>Page Title</title></head><body><p>body</p></body>',
    );
    expect(md.startsWith('# Page Title')).toBe(true);
    expect(md).toContain('body');
  });

  test('title is NOT promoted when the document already has a heading', async () => {
    const md = await htmlToMarkdown('<title>Meta</title><h1>Real</h1><p>x</p>');
    expect(md).toContain('# Real');
    expect(md).not.toContain('# Meta');
  });

  test('unclosed <li> tags still produce items (real-world HTML)', async () => {
    const md = await htmlToMarkdown('<ul><li>first<li>second<li>third</ul>');
    expect(md).toContain('- first\n- second\n- third');
  });

  test('empty input returns empty string', async () => {
    expect(await htmlToMarkdown('')).toBe('');
  });

  test('entities in body decode (named subset + &amp;/&mdash;)', async () => {
    const md = await htmlToMarkdown('<p>open &amp; shut &mdash; done.</p>');
    expect(md).toContain('open & shut — done.');
  });

  test('multi-block <li> emits one marker + indented continuation (no duplicate index)', async () => {
    const md = await htmlToMarkdown('<ol><li><p>a</p><p>b</p></li><li>c</li></ol>');
    expect(md).toContain('1. a\n   b\n2. c');
    expect(md).not.toContain('1. b');
  });

  test('inline <code> containing backticks is fenced, not stripped', async () => {
    const md = await htmlToMarkdown('<p>x <code>a`b`c</code> y</p>');
    expect(md).toContain('``a`b`c``');
    expect(md).not.toContain('abc');
  });

  test('<img> with no src keeps its alt text', async () => {
    const md = await htmlToMarkdown('<p><img alt="Logo"> rest</p>');
    expect(md).toContain('Logo rest');
  });
});
