import { describe, expect, test } from 'bun:test';
import { redactSecrets, redactSecretsInIntermediate } from '../../src/recap/format.ts';
import { RECAP_SCHEMA_VERSION, type RecapIntermediate } from '../../src/recap/types.ts';

const baseIntermediate = (overrides: Partial<RecapIntermediate> = {}): RecapIntermediate => ({
  schemaVersion: RECAP_SCHEMA_VERSION,
  generatedAt: 0,
  scope: { kind: 'session_specific', sessionIds: ['s-1'], range: { start: 0, end: 0 } },
  completeness: { incomplete: false, incompleteSessions: [], incompleteReason: '' },
  goal: { text: '', sourceStepId: '' },
  goalStack: [],
  decisions: [],
  pinnedContext: [],
  actions: {
    filesRead: [],
    filesWritten: [],
    commandsRun: [],
    webFetches: [],
    subagentsSpawned: [],
  },
  outcomes: { testsRun: [], checkpoints: [], artifacts: [] },
  timeline: [],
  costs: {
    tokens: { in: 0, out: 0, cached: 0 },
    usd: 0,
    durationMs: 0,
    model: '',
    cacheHitRatio: 0,
  },
  errors: [],
  notDone: [],
  unresolvedQuestions: [],
  memoryProposed: [],
  ...overrides,
});

describe('redactSecrets', () => {
  test('redacts Anthropic API keys (anthropic-key pattern wins over env-secret)', () => {
    const text = 'export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890';
    const out = redactSecrets(text);
    // The more-specific pattern (anthropic-key) wins; ordering in
    // SECRET_PATTERNS puts it before env-secret. Either label is
    // acceptable redaction; we assert no raw key bytes remain.
    expect(out).toContain('<redacted:anthropic-key>');
    expect(out).not.toContain('sk-ant-api03');
  });

  test('redacts a bare Anthropic key (no env var prefix)', () => {
    const text = 'using sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890 here';
    expect(redactSecrets(text)).toContain('<redacted:anthropic-key>');
    expect(redactSecrets(text)).not.toContain('sk-ant-api03');
  });

  test('redacts OpenAI keys (sk- not anthropic)', () => {
    const text = 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ABCD';
    expect(redactSecrets(text)).toContain('<redacted:openai-key>');
  });

  test('redacts AWS access keys (AKIA / ASIA)', () => {
    expect(redactSecrets('AKIA0123456789ABCDEF')).toContain('<redacted:aws-access-key>');
    expect(redactSecrets('ASIA0123456789ABCDEF')).toContain('<redacted:aws-access-key>');
  });

  test('redacts GitHub tokens', () => {
    expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain(
      '<redacted:github-token>',
    );
    expect(redactSecrets('ghs_abcdefghijklmnopqrstuvwxyz0123456789')).toContain(
      '<redacted:github-token>',
    );
  });

  test('redacts JWT-shaped tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactSecrets(jwt)).toContain('<redacted:jwt>');
  });

  test('redacts Google API keys (AIza prefix + 35 chars)', () => {
    const key = `AIza${'A'.repeat(35)}`;
    expect(redactSecrets(key)).toContain('<redacted:google-api-key>');
    // A short key (< 35 chars after prefix) is NOT a Google API
    // key — must not falsely redact.
    expect(redactSecrets('AIzaShort')).toBe('AIzaShort');
  });

  test('redacts Slack tokens (xoxb / xoxp / xoxa / xoxr / xoxs)', () => {
    expect(redactSecrets('xoxb-1234567890-abcdefghijklm')).toContain('<redacted:slack-token>');
    expect(redactSecrets('xoxp-1234567890-abcdefghijklm')).toContain('<redacted:slack-token>');
    expect(redactSecrets('xoxa-1234567890-abcdefghijklm')).toContain('<redacted:slack-token>');
    // `xoxN-` (N ∉ {b,a,p,r,s}) is not a real Slack token shape;
    // must not falsely redact.
    expect(redactSecrets('xoxn-1234567890-abcdefghijklm')).toBe('xoxn-1234567890-abcdefghijklm');
  });

  test('redacts Bearer tokens', () => {
    const text = 'Authorization: Bearer abcDEF1234567890longenoughtoken';
    expect(redactSecrets(text)).toContain('<redacted:bearer-token>');
  });

  test('preserves env-var key while redacting value', () => {
    const text = 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const out = redactSecrets(text);
    // GITHUB_TOKEN is a valid env-secret label match — github-token
    // matches first (more specific), wrapping the whole token; then
    // the env-secret pattern matches the entire residue.
    expect(out).toContain('<redacted:');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  test('idempotent on already-redacted text', () => {
    const once = redactSecrets(`sk-ant-api03-${'X'.repeat(40)}`);
    const twice = redactSecrets(once);
    expect(once).toBe(twice);
  });

  test('does not falsely redact short or non-secret-shaped strings', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
    expect(redactSecrets('sk-short')).toBe('sk-short'); // too short to match
    expect(redactSecrets('echo /tmp/foo')).toBe('echo /tmp/foo');
  });

  test('does not redact paths that look like keys', () => {
    // A path like /home/user/sk-something should not be redacted
    // unless it exceeds the entropy floor (the pattern requires 20+
    // alphanumeric chars after `sk-`).
    expect(redactSecrets('/home/user/sk-foo.ts')).toBe('/home/user/sk-foo.ts');
  });

  test('handles empty input', () => {
    expect(redactSecrets('')).toBe('');
  });

  test('redacts multiple distinct secrets in one pass', () => {
    const text =
      'ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890 and Bearer abcDEFhijklmnopqrstuvwxyz12345';
    const out = redactSecrets(text);
    expect(out).toContain('<redacted:');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('abcDEFhijklmnopqrstuvwxyz12345');
  });
});

describe('redactSecretsInIntermediate', () => {
  test('redacts goal.text', () => {
    const i = baseIntermediate({
      goal: {
        text: 'use ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
        sourceStepId: 'st',
      },
    });
    const out = redactSecretsInIntermediate(i);
    expect(out.goal.text).toContain('<redacted:');
    expect(out.goal.text).not.toContain('sk-ant-api03');
  });

  test('redacts commandsRun[].command', () => {
    const i = baseIntermediate({
      actions: {
        filesRead: [],
        filesWritten: [],
        commandsRun: [
          {
            command: 'curl -H "Authorization: Bearer abcDEF1234567890longenoughtoken"',
            exitCode: 0,
            durationMs: 1,
          },
        ],
        webFetches: [],
        subagentsSpawned: [],
      },
    });
    const out = redactSecretsInIntermediate(i);
    expect(out.actions.commandsRun[0]?.command).toContain('<redacted:bearer-token>');
  });

  test('redacts decisions.what / why', () => {
    const i = baseIntermediate({
      decisions: [
        {
          stepId: 'st',
          what: 'set ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
          why: 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ABCD',
          decidedBy: 'user',
        },
      ],
    });
    const out = redactSecretsInIntermediate(i);
    expect(out.decisions[0]?.what).toContain('<redacted:');
    expect(out.decisions[0]?.why).toContain('<redacted:');
  });

  test('preserves paths, IDs, numbers, enum-shaped strings', () => {
    const i = baseIntermediate({
      scope: { kind: 'session_specific', sessionIds: ['s-1'], range: { start: 0, end: 0 } },
      actions: {
        filesRead: [{ path: '/home/lex/proj/x.ts', count: 3 }],
        filesWritten: [
          { path: '/home/lex/proj/y.ts', linesAdded: 5, linesRemoved: 2, semanticSummary: '' },
        ],
        commandsRun: [],
        webFetches: [],
        subagentsSpawned: [],
      },
      costs: {
        tokens: { in: 100, out: 50, cached: 10 },
        usd: 0.04,
        durationMs: 4_000,
        model: 'claude-sonnet-4-6',
        cacheHitRatio: 0.5,
      },
    });
    const out = redactSecretsInIntermediate(i);
    expect(out.scope.sessionIds).toEqual(['s-1']);
    expect(out.actions.filesRead[0]?.path).toBe('/home/lex/proj/x.ts');
    expect(out.actions.filesWritten[0]?.path).toBe('/home/lex/proj/y.ts');
    expect(out.costs.usd).toBe(0.04);
    expect(out.costs.model).toBe('claude-sonnet-4-6');
  });

  test('does not mutate the input', () => {
    const i = baseIntermediate({
      goal: { text: `sk-ant-api03-${'X'.repeat(40)}`, sourceStepId: 'st' },
    });
    const original = i.goal.text;
    redactSecretsInIntermediate(i);
    expect(i.goal.text).toBe(original);
  });
});
