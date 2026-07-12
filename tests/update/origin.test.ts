import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { detectInstallOrigin, updateCommand } from '../../src/update/origin.ts';

const INSTALL_SH = 'curl -fsSL https://raw.githubusercontent.com/lex0c/forja/main/install.sh | sh';

describe('detectInstallOrigin', () => {
  test('binary under node_modules/@lex0c/ → npm', () => {
    expect(detectInstallOrigin('/home/u/proj/node_modules/@lex0c/forja-linux-x64/bin/forja')).toBe(
      'npm',
    );
  });

  test('Windows-separator node_modules path → npm (separator-agnostic)', () => {
    expect(
      detectInstallOrigin('C:\\proj\\node_modules\\@lex0c\\forja-windows-x64\\bin\\forja.exe'),
    ).toBe('npm');
  });

  test('node_modules WITHOUT the @lex0c scope → standalone (the scope is load-bearing)', () => {
    expect(detectInstallOrigin('/home/u/proj/node_modules/.bin/forja')).toBe('standalone');
  });

  test('install.sh path (~/.local/bin/forja) → standalone', () => {
    expect(detectInstallOrigin('/home/u/.local/bin/forja')).toBe('standalone');
  });

  test('other non-npm path → standalone (safe default)', () => {
    expect(detectInstallOrigin('/usr/local/bin/forja')).toBe('standalone');
  });
});

describe('updateCommand', () => {
  test('npm → global install pinned to the announced version', () => {
    expect(updateCommand('npm', '0.2.0')).toBe('npm i -g @lex0c/forja@0.2.0');
  });

  test('npm is cross-platform (no OS branch)', () => {
    expect(updateCommand('npm', '0.2.0', 'C:\\x\\forja.exe', 'win32')).toBe(
      'npm i -g @lex0c/forja@0.2.0',
    );
  });

  test('standalone on POSIX at the default prefix → bare install.sh one-liner', () => {
    const execPath = `${homedir()}/.local/bin/forja`;
    expect(updateCommand('standalone', '0.2.0', execPath, 'linux')).toBe(INSTALL_SH);
  });

  test('standalone on POSIX at a custom prefix → install.sh with --prefix (in place)', () => {
    expect(updateCommand('standalone', '0.2.0', '/usr/local/bin/forja', 'linux')).toBe(
      `${INSTALL_SH} -s -- --prefix '/usr/local/bin'`,
    );
  });

  test('a custom prefix with a single quote is POSIX-escaped', () => {
    expect(updateCommand('standalone', '0.2.0', "/home/o'brien/bin/forja", 'linux')).toBe(
      `${INSTALL_SH} -s -- --prefix '/home/o'\\''brien/bin'`,
    );
  });

  test('standalone on Windows → releases page URL (stock cmd/PowerShell has no sh)', () => {
    expect(updateCommand('standalone', '0.2.0', 'C:\\Users\\u\\forja.exe', 'win32')).toBe(
      'https://github.com/lex0c/forja/releases/latest',
    );
  });
});
