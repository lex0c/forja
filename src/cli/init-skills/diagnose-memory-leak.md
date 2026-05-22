---
name:        diagnose-memory-leak
description: Track down a memory leak by measurement — capture heap snapshots over time, diff retention, confirm the fix.
version:     1
trigger_keywords: [memory leak, oom, out of memory, heap growth, rss, retention, gc]
tools:       [bash]
source:      project_shared
created_at:  2026-05-21
updated_at:  2026-05-21
expires:     null
---

## When to use

Goal-shape: "memory keeps growing", "the process gets OOM-killed", "RSS climbs until it falls over". Use when memory grows without bound under steady load — you need to find *what is retained that should have been freed*.

Distinct from siblings: `profile-hotspot` with an allocation profile finds *churn* — total allocation driving GC pressure; this skill finds *retention* — objects the GC cannot collect because something still references them. `debug-failure` is for wrong behavior, not unbounded growth.

Not a use case: memory that is high but **stable** (that is footprint/sizing, not a leak — right-size the process); a one-time spike that plateaus; an out-of-memory from a single oversized allocation (that is a bug for `debug-failure`).

## Prerequisites

- A way to drive a steady, repeating workload for minutes, not seconds.
- A heap/allocation profiler for the runtime (heap snapshots, `tracemalloc`/`memray`, `pprof` heap, `-memprofile`, async-profiler, `heaptrack`).
- A way to observe RSS / heap size over time (`ps`, `/proc`, runtime metrics).

## Procedure

1. **Confirm it is a leak.** Drive a constant workload and watch memory across several GC cycles. A leak grows monotonically and never returns; a sawtooth that falls back to baseline is healthy GC. Stable-but-high is not a leak — stop here if so.
2. **Establish the growth curve.** Record RSS/heap at fixed intervals under the repeating workload. A straight upward trend across GC cycles is the signal; note the rate (MB per 1000 requests) so you can measure the fix.
3. **Capture two heap snapshots** separated by significant load — one early, one after the curve has clearly climbed.
4. **Diff retention.** Compare the snapshots: which object types and sizes *grew*. Follow the retainer chain — dominator tree, "retained by" — from a grown object to the GC root that holds it. That root is the leak.
5. **Form one hypothesis** for why the reference is held: an unbounded cache or map, a listener or subscription never removed, a closure capturing a large scope, a module-level collection that only ever grows, a forgotten timer.
6. **Fix the retention** — bound the cache by size or TTL, remove the listener, drop the reference, scope the closure. Fix what *holds* the memory, not the symptom.
7. **Verify** (see below).

## Verification

- Re-run the long workload: memory **plateaus** instead of climbing — a sawtooth, not a ramp.
- A fresh heap diff over the same load shows the previously-growing object set now stable.
- RSS returns near baseline after the load drains.
- Add a regression check on the old growth rate if the harness allows a bounded-memory assertion.

## Anti-cases

- Treating allocation churn as a leak → a high *allocation rate* with flat *retention* is GC pressure; that is `profile-hotspot` with an alloc profile, not this skill.
- Declaring victory after a 10-second run → leaks need time and GC cycles to show; measure for minutes.
- Chasing fragmentation or the allocator not returning pages to the OS → RSS can stay high while the heap is healthy; check heap-used, not just RSS.
- "Fixing" by raising the memory limit or forcing GC → the leak still grows; it just falls over later.
