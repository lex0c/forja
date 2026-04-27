#!/usr/bin/env bun
// Entry point. Real implementation starts in Step 2.
// Spec: docs/spec/AGENTIC_CLI.md §2 (operation modes).

const VERSION = '0.0.0';

const args = Bun.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
  } else {
    process.stdout.write(`${VERSION}\n`);
  }
  process.exit(0);
}

process.stderr.write('forja: not implemented yet — see docs/spec/AGENTIC_CLI.md §18 (M1)\n');
process.exit(1);
