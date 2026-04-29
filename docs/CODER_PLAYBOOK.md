# Coder Playbook

Patterns and anti-patterns the Forja agent should apply when writing
or reviewing code. Distilled from real bug fixes shipped against this
codebase — every entry is a class of mistake that has been caught at
least once. Read before proposing a non-trivial change.

The patterns are not theoretical. Each one cites the kind of bug it
prevents, and most can be cross-referenced against `docs/BACKLOG.md`
entries that document the original incident.

## How to use this file

Skim the section headers; dive into entries that match the change
you're about to make. The order is roughly by "how often this bites":

1. Async control flow
2. Terminal classification
3. Concurrency on shared state
4. Sibling parity
5. Boundary handling
6. Test completeness
7. Schema and SELECT discipline
8. The meta-pattern

If you're stuck on a bug whose shape doesn't fit any section, read
section 8 — most bugs reduce to "a default behavior was convenient
but wrong, and silent in the corner case".

---

## 1. Async control flow

### 1.1 When `Promise.all` rejects, siblings keep running

`Promise.all` rejects on the FIRST sub-rejection. The other promises
keep running. If those siblings hold timers, signal listeners, or
file descriptors, you have a leak that outlives the function's
return.

Bad:

```ts
const subs = items.map(work);
await Promise.all(subs);  // throws → siblings keep going
```

Good:

```ts
const subs = items.map(work);
try {
  await Promise.all(subs);
} catch (e) {
  abortController.abort();          // signal siblings to stop
  await Promise.allSettled(subs);   // wait for them to drain
  throw e;                          // re-throw original
}
```

The rule: any time you race or fan out promises, you OWN their
cancellation on the failure path. `Promise.all`'s implicit "abandon"
behavior is almost never what you want when each promise holds
resources.

### 1.2 `Promise.any` vs `Promise.race` for "first match wins"

`Promise.race` resolves on the first SETTLED promise — including
ones that resolved with a non-match. `Promise.any` resolves on the
first FULFILLED promise. For "wait until something matches", you
almost always want `Promise.any`. Map non-matches to rejections
so they don't satisfy `Promise.any`.

Bad: `Promise.race(subs)` returns the first sub that finished, even
if its result was `matched=false`.

Good: `Promise.any(subs.map(p => p.then(r => r.matched ? r : Promise.reject(r))))`.

### 1.3 Real errors hidden inside synthetic-rejection patterns

When you map "no match" to `Promise.reject(value)` to feed
`Promise.any`, real exceptions also become rejections. The
`AggregateError.errors` array mixes synthetic non-matches with
real errors. Distinguish by `instanceof Error`.

Bad: catch the AggregateError, return "no match" for everything.

Good: scan `e.errors` for the first `instanceof Error` and rethrow
it. A composition that masks a `process_not_found` error silently
gives the user a wrong answer.

### 1.4 AbortSignal cascades, not duplicates

When you derive a child controller from a parent signal, listen to
the parent and abort the child. Don't poll the parent's `aborted`
flag in your own loops — race conditions abound.

Pattern:

```ts
const childAc = new AbortController();
if (parentSignal.aborted) childAc.abort();
else parentSignal.addEventListener('abort', () => childAc.abort(), { once: true });
```

Always `removeEventListener` in the cleanup path; the `{ once: true }`
flag handles the one-shot case but a manual remove is needed when the
child resolves before the parent fires.

### 1.5 Cleanup runs on every exit path

`finally` / `defer` / explicit `cleanup()` calls protect against
leaks only if every exit path takes them. Audit:

- `return` (especially fast-path early returns)
- `throw`
- `await ... catch`
- early `if` returns

Common miss: a fast-path return that skips the cleanup because "the
normal path will hit it later". The fast path is a path; it needs
its own cleanup.

---

## 2. Terminal classification

### 2.1 `aborted` is not the catch-all fallback

A terminal label like `aborted` should mean "an external signal
cancelled the operation". When a function ends naturally without
matching its goal, that is a *deterministic non-match*, not an
abort.

Bad pattern (real bug, fixed three times in one branch):

```ts
return {
  matched: false,
  conditionMet: timeout.fired() ? 'timeout' : 'aborted',  // 'aborted' as fallback
};
```

If the operation ended because (e.g.) a child process exited cleanly
without producing the expected output, neither timeout nor abort
fired — but the function still labels the result `aborted`. Every
caller that branches on `aborted` (treating it as user-cancelled)
silently does the wrong thing.

Good pattern: make the deterministic case its own terminal.

```ts
if (timeout.fired()) return { conditionMet: 'timeout', ... };
if (callerSignal?.aborted) return { conditionMet: 'aborted', ... };
return { conditionMet: kindThatExplains, ... };  // explicit
```

Priority rule: external-signal terminals (`timeout`, `aborted`) win
over deterministic terminals when both apply, because external
signals mean "the operation was cut short" — more specific than
"the operation reached its natural conclusion".

### 2.2 Distinct terminals for distinct outcomes

If two endings of an operation lead to different downstream
decisions, they need distinct labels. Conflating them corrupts the
trace (principle 7 in `docs/spec/AGENTIC_CLI.md`).

Examples that earned their own terminal in this repo:

- `process_exited` for "I was watching a process and it ended
  without matching" — distinct from `timeout` (still running) and
  `aborted` (caller cancelled).
- `all_of` / `any_of` (with `matched=false`) for "the composition
  resolved deterministically without a winner" — distinct from
  `timeout` (the outer wait was cut short).

If you find yourself thinking "I'll just reuse `timeout` here, it's
close enough", stop. Add the terminal.

### 2.3 The type system is the safety net

When you add a new terminal, add it to the union type.
Exhaustiveness checking on switches over the union catches
incomplete handlers at compile time. Don't widen the type to
`string` to skip the work — the type IS the work.

---

## 3. Concurrency on shared state

### 3.1 Read-then-write is a race

`SELECT` followed by `UPDATE` from a higher value to a lower value
loses concurrent updates. Two readers that have advanced past
position N each write back N — except one reader has actually
advanced to N+50 and the other to N+30. The N+30 write clobbers
the N+50.

Bad:

```ts
const row = db.query("SELECT cursor FROM t WHERE id = ?").get(id);
const newCursor = row.cursor + delta;
db.query("UPDATE t SET cursor = ? WHERE id = ?").run(newCursor, id);
```

Good (DB-level monotonic guard):

```ts
db.query(
  "UPDATE t SET cursor = ? WHERE id = ? AND cursor < ?"
).run(newCursor, id, newCursor);
```

The `AND cursor < ?` clause makes the write a no-op when another
writer has already advanced past `newCursor`. Atomic at the DB
layer, no transaction needed.

### 3.2 Explicit overrides should be transient

When a function takes an explicit "start from position X" argument,
honor it for THIS call but DON'T persist it. Persisting overrides
rewinds shared state for everyone else.

Pattern: the caller passes `since: number`. The function reads from
`since`, returns the resulting data and the new cursor, but does
NOT update the persisted cursor. Only the canonical (no-`since`)
call path updates persistence.

Why: a peek-style operation (e.g. wait_for polling for a marker)
must not consume the bytes a model-facing read will later see.

### 3.3 Trust internal state, validate at boundaries

You cannot make every internal function defensive against every
upstream caller. Validate at SYSTEM BOUNDARIES (tool input,
external API responses, file content). Inside, trust the contract.

But: schema-level constraints declared at the boundary
(`minimum: 10`, `minimum: 1`) are NOT enforced unless you check
them. Models send unvalidated JSON. A schema declaration without
a runtime check is a contract you HOPE holds, not one you ENFORCE.

Pattern: every schema constraint has a parallel runtime guard that
returns a clean error.

### 3.4 Cumulative fields need to be seeded, not overwritten

When a row holds a CUMULATIVE value (cost, counts, totals, byte
sums) and your code path ends with an `UPDATE table SET col = ?`,
the local accumulator MUST start from the existing persisted
value — not zero.

Real bug from this repo:

```ts
// In runAgent's resume path:
let totalCostUsd = 0;            // local accumulator
// ... resume runs new turns, totalCostUsd grows by N
completeSession(db, id, status, totalCostUsd, ...);
// → UPDATE sessions SET total_cost_usd = N WHERE id = ?
//   The prior $0.50 the session had cost is now $N. History lost.
```

Fix:

```ts
let totalCostUsd = 0;
if (resumeId !== undefined) {
  const existing = getSession(db, resumeId);
  totalCostUsd = existing.totalCostUsd;  // seed from the row
}
// ... resume runs add to totalCostUsd
completeSession(db, id, status, totalCostUsd, ...);
// → UPDATE writes (prior + new)
```

This is the dual of §3.1 (`AND col < ?` defends against concurrent
writes overwriting forward progress). Here we defend against the
SAME function losing its own prior history because it didn't
read before writing.

When you see this pattern, ask:

- Is this column cumulative semantically (cost, count, total) or
  monotonic (cursor, version)?
- Does the UPDATE replace the entire value, or merge?
- If replace + cumulative, you need a seed read.

Audit prompts that catch this:

- "What columns does completeSession / closeX / finalize* write?"
- "For each, is the local accumulator seeded from the row at
  init, or does it start at zero?"
- "If start-at-zero: is the column genuinely fresh-per-call, or
  does the function get called for an existing row?"

---

## 4. Sibling parity

When two primitives share a contract (e.g. `wait_for` and `monitor`,
`bash` and `bash_background`), drift between them is a smell.
Sibling primitives that diverge in subtle ways breed bugs in the
seam.

### 4.1 Validation parity

If `wait_for` validates `poll_interval_ms >= 10` at runtime, so does
`monitor`. Once a constraint is justified for one, the other inherits
the justification — defending less is defending nothing.

### 4.2 Path resolution

Relative paths must resolve against the SESSION cwd (`ctx.cwd`),
NOT the process cwd (`process.cwd()`). They differ. The session
cwd follows the user's intent; `process.cwd()` is whatever the
binary was launched from.

Bad: `resolve(process.cwd(), userPath)`.
Good: `resolve(ctx.cwd, userPath)`.

This is also a security boundary: path traversal checks (`..`
rejection, `allow_paths` / `deny_paths`) must run BEFORE
resolution.

### 4.3 Convention boundaries are seams, not sprinkles

Internal code uses one convention (e.g. camelCase TS); the model-
facing tool surface uses another (snake_case JSON). The conversion
must happen AT THE BOUNDARY (one place: the tool's `execute`
return), not sprinkled through the code.

When you add a payload field, you don't update conversion code —
because conversion is generic and runs at the seam.

### 4.4 Category, not name

When the policy / permissions / display layer routes by tool name,
adding a new tool with a similar role accidentally falls through to
default-deny. Route by CATEGORY instead: `bash`, `bash_background`,
and `bash_output` all map to category `bash` for policy decisions.

### 4.5 Coarse category, fine-grained side effects

A category gate is too coarse when the tool's leaf operations
touch resources governed by OTHER policy sections. Example: a
`misc`-category tool that performs fs reads and HTTP probes per
condition. The harness's category check passes (`misc` allows),
and the tool then bypasses `tools.read_file` allow_paths and
`tools.fetch_url` allow_hosts entirely.

Pattern: when a tool's leaves cover surfaces that have their own
policy sections, self-gate per leaf by calling the engine with the
appropriate (toolName, category, args) for each gated kind. Reuse
existing sections — don't introduce parallel ones, because
operators have to keep them in sync and will forget.

In this repo:
- `wait_for`'s `file_*` leaves call the engine as
  `(read_file, fs.read, { path })`.
- `wait_for`'s `http_response` and `port_open` leaves call as
  `(fetch_url, web.fetch, { url })`, with port_open synthesizing
  `http://host:port` so the engine extracts hostname for
  `allow_hosts` matching.
- `monitor`'s `file_changes` mirrors the wait_for fs gate.

Process-aware leaves (`process_exit`, `process_output_*`) are NOT
re-gated — the process was authorized at spawn time, and reading
its log is not a new resource access. Re-gating would be a false
positive that punishes the operator for legitimate orchestration.

The seam: tools that need this expose a `permissionCheck` callback
on `ToolContext`. The harness wires it from the engine; tests
inject custom predicates to verify deny / allow paths.

---

## 5. Boundary handling

### 5.1 Drain before declaring end

When a stream source closes, there are usually still bytes in the
buffer. Reading once and giving up loses the tail.

Pattern:

```ts
let r = await read();
while (!r.matched && r.pending > 0) {
  r = await read();
}
```

Stop only when `pending === 0` AND no match. The pre-existing
pending bytes might contain the answer.

Real example: a process emits >64KB and exits. The first read
(capped at 64KB) returns a chunk; pending says "+6KB". Without the
drain loop, the marker in the last 6KB is silently lost.

### 5.2 Overlap windows for boundary-straddling patterns

When you scan incremental chunks for a regex, the pattern might
span the boundary between two reads. Carry over the last N bytes
from chunk K-1 into chunk K's scan window. Deduplicate matches
that fall in the overlap region (otherwise you fire twice for the
same match).

Caveat: patterns longer than the overlap can still be missed. Pick
N based on the longest expected pattern, document the assumption.

### 5.3 Bounded buffers in incremental reads

Any "accumulate until newline / sentinel / size" loop must have a
hard cap. A pathological input with no newline can grow the buffer
unbounded, exhausting memory.

Pattern: define `MAX_BUFFER_BYTES`. When hit, flush whatever is in
the buffer as a "synthetic line" (or equivalent), reset, and
continue. Document the cap in the type's comment.

---

## 6. Test completeness

### 6.1 `matched=false` alone is half a test

If a function's output has multiple non-match terminals, asserting
only `matched=false` lets the wrong terminal label slip through.
Always assert the terminal classification too.

Bad:

```ts
expect(result.matched).toBe(false);
```

Good:

```ts
expect(result.matched).toBe(false);
expect(result.conditionMet).toBe('timeout');  // or whichever
```

The same applies to `success=false`, `ok=false`, `error=true` — any
boolean result that hides a richer underlying classification.

### 6.2 Lock down what would surprise a future reader

If a test passes for the wrong reason (e.g. the bug accidentally
produces the right value), the test doesn't catch the regression
when the bug is fixed differently. Assert ENOUGH that the test
fails loudly when behavior drifts in any plausible direction.

### 6.3 Tests as regression markers, not just specs

When a fix lands, the test that would have caught it ships
alongside the fix. Don't trust "the next iteration of the test
suite will catch this" — it won't, because by then nobody
remembers what the test was supposed to defend against.

Comment on each regression test: "previously, X; now, Y" — so a
future reader (including future-you) understands what the test is
preserving.

---

## 7. Schema and SELECT discipline

### 7.1 Adding a column requires a SELECT audit

When you add a column to a table, every `SELECT` for that table
needs review. If the SELECT lists columns explicitly (which it
should), the new column is silently dropped from results.

Pattern:

- Add the column.
- Grep for `SELECT.*FROM <table>`.
- Update each match.
- Add a test that round-trips the new column through the most
  common access path.

### 7.2 `replace_all` on similar SQL is dangerous

When two SQL strings differ only by indentation (or a comma), a
`replace_all` may match only one. Always verify by grepping for the
OLD string after the edit — a non-empty result means the replace
missed.

Same applies to any "edit all instances" operation across
near-duplicate strings.

---

## 8. The meta-pattern

Most of the bugs cataloged above share a common shape: a default
behavior that is convenient but wrong, and silent in the corner
case.

- `Promise.all`'s default abandonment of siblings on rejection.
- A "finishUnmatched" helper's default of `aborted` for any non-
  timeout end.
- `SELECT col1, col2`'s default of dropping any unlisted column.
- A buffer's default of growing without bound.
- A schema declaration's default of NOT enforcing constraints at
  runtime.

When you write code that depends on the default behavior of a
primitive, ask:

> What does this primitive do when the input is adversarial,
> pathological, or boundary-positioned?

If you can't answer, your code probably has a corner-case bug.
Default behaviors are accountability fallbacks. Make them safe (or
make them explicit failures), not silent.

### The audit reflex

Three fixes in a row of the same shape is not coincidence — it's
a hint that the helper / abstraction itself is mis-designed. After
the second occurrence, audit the abstraction. After the third, fix
the abstraction (don't just patch the next instance).

In this repo, the third occurrence of "no-match path mis-labeled
as `aborted`" prompted a coverage audit across all wait/composition
tests, which found four more places where the same regression class
could have slipped through silently. Pattern: when you fix bug N of
class C, also write the test that would have caught bugs 1..N-1.
