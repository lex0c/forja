import { describe, expect, test } from 'bun:test';
import { expandTemplate } from '../../src/hooks/template.ts';

describe('expandTemplate — happy path', () => {
  test('substitutes simple key', () => {
    const r = expandTemplate('echo {{event}}', { event: 'PostToolUse' });
    expect(r.expanded).toBe("echo 'PostToolUse'");
    expect(r.references).toEqual([{ key: 'event', raw: false, resolved: true }]);
  });

  test('walks dotted paths', () => {
    const r = expandTemplate('prettier {{tool.input.path}}', {
      tool: { input: { path: '/repo/x.ts' } },
    });
    expect(r.expanded).toBe("prettier '/repo/x.ts'");
  });

  test('multiple placeholders in one command', () => {
    const r = expandTemplate('audit {{event}} {{tool.input.path}}', {
      event: 'PreToolUse',
      tool: { input: { path: '/repo/y.ts' } },
    });
    expect(r.expanded).toBe("audit 'PreToolUse' '/repo/y.ts'");
  });

  test('numbers and booleans render as strings', () => {
    const r = expandTemplate('cost {{cost_usd}} done {{done}}', {
      cost_usd: 0.123,
      done: true,
    });
    expect(r.expanded).toBe("cost '0.123' done 'true'");
  });
});

describe('expandTemplate — shell-injection defense', () => {
  test('quotes single-quote in value (POSIX close-escape-open)', () => {
    const r = expandTemplate('echo {{name}}', { name: "it's" });
    // Result must be a single shell argument; embedded quote
    // becomes the close-escaped-open-quote sequence.
    expect(r.expanded).toBe("echo 'it'\\''s'");
  });

  test('quotes shell metachars', () => {
    const r = expandTemplate('echo {{cmd}}', { cmd: 'ls; rm -rf /' });
    expect(r.expanded).toBe("echo 'ls; rm -rf /'");
  });

  test('quotes backticks and dollar-paren', () => {
    // Build the string via concat so Bun's TS parser doesn't
    // confuse the dollar-paren run inside a literal with template
    // interpolation.
    const tick = String.fromCharCode(0x60);
    const value = `${tick}whoami${tick}$(id)`;
    const r = expandTemplate('echo {{cmd}}', { cmd: value });
    expect(r.expanded).toBe(`echo '${value}'`);
  });

  test('embedded newlines preserved as a single shell arg', () => {
    const r = expandTemplate('cat << EOF\n{{body}}\nEOF', { body: 'line1\nline2' });
    // Multiline value still wrapped in '...'; sh receives it as
    // one argument.
    expect(r.expanded).toBe("cat << EOF\n'line1\nline2'\nEOF");
  });
});

describe('expandTemplate — escape hatch (raw)', () => {
  test('{{!path}} skips quoting', () => {
    const r = expandTemplate('echo {{!frag}}', { frag: 'pre-quoted' });
    expect(r.expanded).toBe('echo pre-quoted');
    expect(r.references).toEqual([{ key: 'frag', raw: true, resolved: true }]);
  });

  test('raw missing key yields empty string (not "")', () => {
    const r = expandTemplate('echo {{!gone}}', {});
    expect(r.expanded).toBe('echo ');
    expect(r.references[0]?.resolved).toBe(false);
  });
});

describe('expandTemplate — missing keys', () => {
  test('quoted missing key resolves to empty quoted arg', () => {
    const r = expandTemplate('echo {{nope}}', {});
    expect(r.expanded).toBe("echo ''");
    expect(r.references).toEqual([{ key: 'nope', raw: false, resolved: false }]);
  });

  test('partial path with non-object segment treats as missing', () => {
    const r = expandTemplate('echo {{tool.input.path}}', { tool: 'string' });
    expect(r.expanded).toBe("echo ''");
    expect(r.references[0]?.resolved).toBe(false);
  });

  test('object value treated as missing (no [object Object] splice)', () => {
    const r = expandTemplate('echo {{tool}}', { tool: { name: 'bash' } });
    expect(r.expanded).toBe("echo ''");
    expect(r.references[0]?.resolved).toBe(false);
  });

  test('null value treated as missing', () => {
    const r = expandTemplate('echo {{x}}', { x: null });
    expect(r.expanded).toBe("echo ''");
    expect(r.references[0]?.resolved).toBe(false);
  });
});

describe('expandTemplate — prototype-pollution defense', () => {
  // Earlier cut walked the path via raw bracket access, so
  // `{{constructor.name}}` resolved against `Object.prototype.
  // constructor.name` and spliced the string `'Object'` into
  // the command — operator-authored templates could
  // inadvertently exfiltrate prototype property values.
  // `Object.hasOwn` rejects all inherited props.

  test('{{__proto__.x}} resolves to empty (not a prototype walk)', () => {
    const r = expandTemplate('echo {{__proto__.toString}}', { x: 1 });
    expect(r.expanded).toBe("echo ''");
    expect(r.references[0]?.resolved).toBe(false);
  });

  test('{{constructor.name}} does NOT splice "Object"', () => {
    const r = expandTemplate('echo {{constructor.name}}', {});
    expect(r.expanded).toBe("echo ''");
    expect(r.references[0]?.resolved).toBe(false);
  });

  test('intermediate prototype walk also blocked', () => {
    const r = expandTemplate('echo {{tool.constructor.name}}', {
      tool: { name: 'real' },
    });
    expect(r.expanded).toBe("echo ''");
    expect(r.references[0]?.resolved).toBe(false);
  });

  test('own property with same name as prototype prop still resolves', () => {
    // Operator-authored payload may legitimately include a
    // `toString` field as an own property — that should still
    // resolve; only inherited props are blocked.
    const r = expandTemplate('echo {{toString}}', { toString: 'hello' });
    expect(r.expanded).toBe("echo 'hello'");
  });
});

describe('expandTemplate — passthrough', () => {
  test('command with no placeholders is unchanged', () => {
    const r = expandTemplate('prettier --write', {});
    expect(r.expanded).toBe('prettier --write');
    expect(r.references).toEqual([]);
  });

  test('whitespace inside placeholder is trimmed', () => {
    const r = expandTemplate('echo {{ event }}', { event: 'X' });
    expect(r.expanded).toBe("echo 'X'");
  });
});
