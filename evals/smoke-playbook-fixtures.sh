#!/usr/bin/env bash
# Smoke runner for playbook eval fixtures (slice 10).
#
# Loads every per-playbook fixture under `evals/playbooks/<name>/`
# and every routing fixture under `evals/playbooks/_routing/`,
# reporting counts. A loader exception aborts the script with a
# non-zero exit so CI catches malformed YAML before it ships.
#
# This is shape-only — it does NOT dispatch the playbooks against
# a real provider. The actual eval runner (live model calls)
# lands in a future slice; this script gates the data layer.

set -euo pipefail

cd "$(dirname "$0")/.."

bun -e '
import { loadPlaybookFixtures, loadRoutingFixtures } from "./src/evals/playbook-fixtures.ts";

const root = "./evals/playbooks";
const playbookFx = loadPlaybookFixtures(root);
const routing = loadRoutingFixtures(root);

const playbookNames = new Set(playbookFx.map((f) => f.directory));
const routingFlavors = new Map<string, number>();
for (const r of routing) {
  routingFlavors.set(r.expectDispatch, (routingFlavors.get(r.expectDispatch) ?? 0) + 1);
}

console.log(`per-playbook fixtures: ${playbookFx.length} across ${playbookNames.size} playbooks`);
for (const name of [...playbookNames].sort()) {
  const count = playbookFx.filter((f) => f.directory === name).length;
  console.log(`  ${name}: ${count}`);
}

console.log(`\nrouting fixtures: ${routing.length}`);
for (const [flavor, count] of [...routingFlavors.entries()].sort()) {
  console.log(`  ${flavor}: ${count}`);
}

console.log("\nsmoke OK");
'
