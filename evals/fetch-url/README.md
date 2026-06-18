# fetch_url evals

Model-in-the-loop coverage for the `fetch_url` tool (TOOLS.md step 9 / CLAUDE.md
"eval is load-bearing"). Run with:

```
bun run eval:fetch-url
```

Like every eval here, this needs a real model (an `ANTHROPIC_API_KEY`) — it asks
whether the model *chooses* and *uses* the tool correctly, which a unit test
can't. The **fetch target is hermetic**, though: each case serves its page via
`setup.httpStub`, which the executor wires by swapping in a `fetch_url` whose DNS
and fetch are stubbed (an injected `lookup` resolves every host to a public test
IP; the injected `fetch` maps the pinned IP request back to the canned URL via
the `Host` header). A plain global-`fetch` swap can't work post-pinning — the
tool resolves + validates + connects to a pinned IP, and the SSRF blocklist
refuses any local stub server, so there is nowhere on the box to point a real
fetch.

`fetch_url` is host-gated, so each case pre-trusts its stub host via
`tools.fetch_url.allow_hosts` in a `.forja/permissions.yaml` fixture — otherwise
the unknown host confirms and dead-ends as a deny in the headless run. (A host
with no working sandbox boots the engine `degraded`, which downgrades the
`allow` to a confirm; run on a box with `bwrap`/`sandbox-exec`.)

Cases:

- **01-fetch-and-extract** — positive path: the model fetches a doc URL and reports
  a value the HTML→markdown conversion surfaces.
- **02-no-false-fetch** — negative gate: with `fetch_url` available, the model still
  uses `read_file` for a local-file question instead of over-fetching.

The in-loop plumbing (the `httpStub` seam — `buildFetchStubRegistry` injecting a
stubbed-DNS, Host-mapped `fetch_url`) is also covered hermetically, without an API
key, by `tests/evals/executor.test.ts` and `tests/tools/fetch-url.test.ts`.
