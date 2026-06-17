import { describe, expect, test } from 'bun:test';
import { expandTilde } from '../../src/permissions/tilde.ts';

describe('expandTilde', () => {
  const home = '/home/op';

  test('bare ~ maps to home', () => {
    expect(expandTilde('~', home)).toBe(home);
  });

  test('~/<rest> maps under home', () => {
    expect(expandTilde('~/.ssh/id_rsa', home)).toBe('/home/op/.ssh/id_rsa');
    expect(expandTilde('~/a', home)).toBe('/home/op/a');
  });

  test('matches the previous config.ts slice(1) form for ~/<rest>', () => {
    // config.ts used `${home}${pattern.slice(1)}`; the shared impl uses
    // `${home}/${path.slice(2)}`. Both must yield the identical string, else
    // the dedup would silently shift protected-path redefinition detection.
    const pattern = '~/.bashrc';
    expect(expandTilde(pattern, home)).toBe(`${home}${pattern.slice(1)}`);
  });

  test('~user (other-user) stays literal — no unsafe OS resolution', () => {
    expect(expandTilde('~root/.ssh', home)).toBe('~root/.ssh');
    expect(expandTilde('~alice', home)).toBe('~alice');
  });

  test('non-tilde paths pass through unchanged', () => {
    expect(expandTilde('/etc/hosts', home)).toBe('/etc/hosts');
    expect(expandTilde('src/a.ts', home)).toBe('src/a.ts');
    expect(expandTilde('./rel', home)).toBe('./rel');
  });

  test('a literal ~ mid-path is not expanded (only a leading ~/ or bare ~)', () => {
    expect(expandTilde('src/~/x', home)).toBe('src/~/x');
  });
});
