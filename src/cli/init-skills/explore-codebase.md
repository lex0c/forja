---
name:        explore-codebase
description: Build a working mental model of an unfamiliar codebase fast — entry points, structure, conventions.
version:     1
trigger_keywords: [explore, unfamiliar, onboard, new codebase, orient, how does this work, where is]
tools:       [bash]
source:      project_shared
created_at:  2026-05-21
updated_at:  2026-05-21
expires:     null
---

## When to use

Goal-shape: "I am new to this repo", "how is this project structured", "where does X happen". Use before changing code in an area you do not yet understand — orientation first prevents a change that fights the existing design.

Distinct from siblings: `debug-failure` investigates one specific failure; this skill builds *general* orientation. `git-bisect-regression` searches history; this reads the current tree.

Not a use case: an area you already know — skip the ceremony and just work; a single-fact lookup ("where is function `foo`") — that is one `grep`, not a procedure.

## Prerequisites

- The repository checked out locally.
- The build and test commands (usually in the README or the package manifest).

## Procedure

1. **Read the map, not the territory.** Start with the README, `docs/`, the package manifest, and the dependency list. The dependencies alone tell you the stack, the framework, and the rough shape of the system.
2. **Find the entry points.** Locate `main` / `index` / the CLI or server bootstrap / the build target. Understanding flows *from* where execution starts, not from a file picked at random.
3. **Map the top level.** List the top-level source directories and name the responsibility of each in one phrase. A directory you cannot summarize is one to look into.
4. **Trace one real path end to end.** Pick a representative request, command, or feature and follow it through every layer — entry, routing, logic, storage, response. One full path teaches the architecture better than reading ten files breadth-first.
5. **Learn the conventions.** Before writing anything, read an existing example of the thing you will write: how tests are laid out, how errors are handled, how things are named. Match what is already there.
6. **Write down what you did NOT explore.** Name the areas you skipped. An explicit "not checked" is honest; a silent assumption that the rest works like the part you saw is a future bug.

## Verification

- You can name where a planned change belongs and roughly which files it touches.
- You can run the build and the test suite successfully.
- You traced at least one path end to end and can explain it without re-reading.
- Your "not checked" list is explicit, not implied.

## Anti-cases

- Reading files alphabetically or breadth-first → you drown before you understand; follow execution paths instead.
- Trusting comments and docs over the code when they disagree → docs rot; the code is what runs. Verify against it.
- Exhaustive exploration → explore to the depth the task needs, then stop; boiling the ocean is its own form of procrastination.
- Starting to edit before you can name the change's blast radius → orientation is not done yet.
