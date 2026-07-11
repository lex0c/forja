// Slice 159 (review — SEC §8.4 wire). Engine-level integration tests
// for the sensitive-path engine-floor refuse. Pre-slice the matcher
// existed in `src/subagents/sensitive-paths.ts` but was only consumed
// by `worktree-validation.ts`. The fs tools (`read_file`, `write_file`,
// `edit_file`, `grep`, `glob`) bypassed it entirely — a permissive
// operator policy like `allow_paths: ['**']` authorized
// `read_file('.env')` end-to-end, returning secrets in `tool_calls.output`
// (persisted to the DB).
//
// Post-slice the engine's `checkPath` runs `matchSensitivePath` BEFORE
// policy lookup, returning a `deny` decision whose `reason` cites the
// matching pattern. The bash bypass-mode capability loop wires the same
// matcher (no operator-mode override).
//
// These tests pin: (1) each canonical pattern from §8.4 triggers refuse
// on read AND write; (2) operator policy cannot widen access; (3)
// non-sensitive paths still flow through policy normally (regression);
// (4) bash bypass mode honors §8.4.

import { beforeAll, describe, expect, test } from 'bun:test';
import { initBashParser } from '../../src/permissions/bash-parser.ts';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import type { Policy } from '../../src/permissions/types.ts';

beforeAll(async () => {
  await initBashParser();
});

const CWD = '/proj';
const HOME = '/home/op';

const policy = (p: Partial<Policy>): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
  ...p,
});

describe('SEC §8.4 sensitive-paths engine-floor refuse — read tools', () => {
  test('read_file .env → refuse with §8.4 reason', () => {
    const eng = createPermissionEngine(
      // Most permissive policy possible. The engine-floor refuse must
      // fire BEFORE policy lookup.
      policy({ tools: { read_file: { allow_paths: ['**'] } } }),
      { cwd: CWD, home: HOME },
    );
    const d = eng.check('read_file', 'fs.read', { path: '.env' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.reason).toContain('SEC §8.4');
      expect(d.reason).toContain('.env');
    }
  });

  test('read_file .env.production → refuse (matches .env.* pattern)', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: '.env.production' }).kind).toBe('deny');
  });

  test('read_file .envrc → refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: '.envrc' }).kind).toBe('deny');
  });

  test('read_file deep/subdir/.env → refuse (any-depth match)', () => {
    // Normalization choice 1 in sensitive-paths.ts: bare-name patterns
    // fire at any depth, not only at root.
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: 'deep/subdir/.env' }).kind).toBe('deny');
  });

  test('read_file deploy/keys/server.pem → refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    const d = eng.check('read_file', 'fs.read', { path: 'deploy/keys/server.pem' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toContain('*.pem');
  });

  test('read_file id_rsa → refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: 'id_rsa' }).kind).toBe('deny');
    expect(eng.check('read_file', 'fs.read', { path: 'id_rsa.pub' }).kind).toBe('deny');
    expect(eng.check('read_file', 'fs.read', { path: 'id_ed25519' }).kind).toBe('deny');
  });

  test('read_file .aws/credentials → refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: '.aws/credentials' }).kind).toBe('deny');
    expect(eng.check('read_file', 'fs.read', { path: '.aws/config' }).kind).toBe('deny');
  });

  test('read_file .netrc → refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: '.netrc' }).kind).toBe('deny');
  });

  test('read_file deploy/credentials.json → refuse (**/credentials*.json)', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: 'deploy/credentials.json' }).kind).toBe(
      'deny',
    );
    expect(eng.check('read_file', 'fs.read', { path: 'ci/credentials-prod.json' }).kind).toBe(
      'deny',
    );
  });

  test('read_file infra/secrets.yml + ci/secrets.yaml → refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: 'infra/secrets.yml' }).kind).toBe('deny');
    expect(eng.check('read_file', 'fs.read', { path: 'ci/secrets.yaml' }).kind).toBe('deny');
  });

  test('read_file .git-credentials → refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('read_file', 'fs.read', { path: '.git-credentials' }).kind).toBe('deny');
  });
});

describe('SEC §8.4 sensitive-paths engine-floor refuse — write tools', () => {
  test('write_file .env → refuse (writes blocked too — spec §8.4 point 2)', () => {
    const eng = createPermissionEngine(policy({ tools: { write_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    const d = eng.check('write_file', 'fs.write', { path: '.env' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toContain('SEC §8.4');
  });

  test('write_file deploy/server.pem → refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { write_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('write_file', 'fs.write', { path: 'deploy/server.pem' }).kind).toBe('deny');
  });

  test('edit_file infra/secrets.yml → refuse', () => {
    const eng = createPermissionEngine(policy({ tools: { edit_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    expect(eng.check('edit_file', 'fs.write', { path: 'infra/secrets.yml' }).kind).toBe('deny');
  });
});

describe('SEC §8.4 engine-floor refuse — operator policy cannot widen', () => {
  test('explicit allow_paths matching the sensitive path still refuses', () => {
    // Operator explicitly allows .env in policy. Engine-floor refuse
    // takes precedence — by design, §8.4 is outside the operator's
    // policy surface (same posture as HARD_REFUSE_COMMANDS in bash).
    const eng = createPermissionEngine(
      policy({ tools: { read_file: { allow_paths: ['.env', '.env.*'] } } }),
      { cwd: CWD, home: HOME },
    );
    expect(eng.check('read_file', 'fs.read', { path: '.env' }).kind).toBe('deny');
    expect(eng.check('read_file', 'fs.read', { path: '.env.local' }).kind).toBe('deny');
  });

  test('session-allow cannot widen access to sensitive paths', () => {
    const eng = createPermissionEngine(
      policy({ tools: { read_file: { confirm_paths: ['**'] } } }),
      { cwd: CWD, home: HOME },
    );
    // Operator answers the modal with "Yes, don't ask again for .env".
    // Engine still refuses on the next call — session-allow runs
    // AFTER §8.4.
    eng.addSessionAllow('read_file', '.env');
    expect(eng.check('read_file', 'fs.read', { path: '.env' }).kind).toBe('deny');
  });

  test('mode=acceptEdits does NOT override §8.4', () => {
    // `acceptEdits` is the auto-confirm-writes mode. It does NOT
    // bypass policy lookup (that's `bypass`'s role) — checkPath
    // still runs, and §8.4 fires inside checkPath BEFORE policy
    // lookup. So acceptEdits has no effect on §8.4 refuses.
    const eng = createPermissionEngine(
      policy({ defaults: { mode: 'acceptEdits' }, tools: { read_file: { allow_paths: ['**'] } } }),
      { cwd: CWD, home: HOME },
    );
    expect(eng.check('read_file', 'fs.read', { path: '.env' }).kind).toBe('deny');
  });

  test('mode=bypass does NOT override §8.4 for fs-tools (refuses outright)', () => {
    // Bypass mode is handled in engine.check() at the dispatch layer
    // BEFORE the per-category switch — `if (mode === 'bypass')` runs
    // for ALL tools (not just bash). The bypass branch iterates the
    // resolved capabilities; for each `read-fs`/`write-fs`/`delete-fs`
    // capability it runs the §11 protected-zone check AND (slice 159)
    // the §8.4 sensitive-path check. So fs-tools in bypass mode go
    // through the SAME wire as bash in bypass mode.
    //
    // Operator setting `mode=bypass` has chosen to skip policy rule
    // matching for routine tool calls, but the spec is explicit that
    // bypass does NOT override engine-floor refuses. Same posture as
    // the §11 message ("bypass mode does NOT override §11").
    const eng = createPermissionEngine(
      policy({ defaults: { mode: 'bypass' }, tools: { read_file: { allow_paths: ['**'] } } }),
      { cwd: CWD, home: HOME },
    );
    const d = eng.check('read_file', 'fs.read', { path: '.env' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.reason).toContain('SEC §8.4');
      expect(d.reason).toContain('bypass mode does NOT override');
    }
  });
});

describe('SEC §8.4 engine-floor refuse — bash bypass mode (capability loop)', () => {
  test('bash bypass: read-fs cap for .env → refuse', () => {
    const eng = createPermissionEngine(policy({ defaults: { mode: 'bypass' } }), {
      cwd: CWD,
      home: HOME,
    });
    // The bash resolver emits a read-fs capability for `cat .env`.
    // Bypass-mode iterates caps and the §8.4 wire refuses on match.
    const d = eng.check('bash', 'bash', { command: 'cat .env' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') {
      expect(d.reason).toContain('SEC §8.4');
      expect(d.reason).toContain('bypass mode does NOT override');
    }
  });

  test('bash bypass: write-fs cap for *.pem → refuse', () => {
    const eng = createPermissionEngine(policy({ defaults: { mode: 'bypass' } }), {
      cwd: CWD,
      home: HOME,
    });
    const d = eng.check('bash', 'bash', { command: 'cp foo.pem dest/' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toContain('SEC §8.4');
  });
});

describe('SEC §8.4 — non-sensitive paths flow through policy normally (regression)', () => {
  test('read_file src/foo.ts allowed by policy → allow', () => {
    const eng = createPermissionEngine(
      policy({ tools: { read_file: { allow_paths: ['src/**'] } } }),
      { cwd: CWD, home: HOME },
    );
    expect(eng.check('read_file', 'fs.read', { path: 'src/foo.ts' }).kind).toBe('allow');
  });

  test('write_file docs/readme.md allowed by policy → allow', () => {
    const eng = createPermissionEngine(
      policy({ tools: { write_file: { allow_paths: ['docs/**'] } } }),
      { cwd: CWD, home: HOME },
    );
    expect(eng.check('write_file', 'fs.write', { path: 'docs/readme.md' }).kind).toBe('allow');
  });

  test('files NAMED similar but not matching pattern flow through', () => {
    // `.envoy.json` is NOT a match for `.env.*` (Glob is strict on
    // dots) — should hit the operator's policy normally.
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    // `envconfig.json` — no leading dot, no match against `.env*`
    // patterns.
    expect(eng.check('read_file', 'fs.read', { path: 'src/envconfig.json' }).kind).toBe('allow');
    // `pemfile.txt` — no `.pem` suffix.
    expect(eng.check('read_file', 'fs.read', { path: 'docs/pemfile.txt' }).kind).toBe('allow');
  });
});

describe('SEC §8.4 — audit row carries sensitive-path refuse reason', () => {
  test('refused row has source.section=protected', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
      home: HOME,
    });
    const d = eng.check('read_file', 'fs.read', { path: '.env' });
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny' && d.source !== undefined) {
      // Source carries the protected section name so audit consumers
      // can distinguish §8.4 refuses from operator-policy refuses.
      expect(d.source.section).toBe('protected');
      expect(d.source.layer).toBe('default');
    }
  });
});
