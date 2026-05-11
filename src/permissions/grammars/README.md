# Grammars

WebAssembly grammars for `web-tree-sitter` consumed by the permission
engine. Each `.wasm` is the precompiled parser for one language;
loaded once at bootstrap via `Language.load(bytes)` and reused for
every `engine.check()` invocation that needs to parse that language.

## Files

| File | Source | Used by |
|---|---|---|
| `tree-sitter-bash.wasm` | `tree-sitter-bash` npm package, v0.25.1 | `src/permissions/bash-parser.ts` |

## Provenance

The bash grammar wasm comes from `tree-sitter-bash@0.25.1`
(`registry.npmjs.org/tree-sitter-bash/-/tree-sitter-bash-0.25.1.tgz`,
file `package/tree-sitter-bash.wasm`). Upstream grammar source is
`github.com/tree-sitter/tree-sitter-bash@v0.25.1`. The package also
contains native bindings for Node — we don't link those; only the
`.wasm` is checked in here.

We pick the upstream package's wasm over the `tree-sitter-wasms`
re-package because the upstream ships ABI-current with the latest
`web-tree-sitter` runtime (v0.26.x); older redistributions can fail
`Language.load` with a dylink metadata mismatch.

The wasm is checked in to the repo so the binary release pipeline
doesn't require an active npm registry at build time and so
`bun build --compile` can embed it deterministically. See
`docs/spec/TREE_SITTER_SHELL.md` §13.1 for the upstream packaging
choice rationale.

## Update process

1. `bun pm view tree-sitter-bash` to confirm the latest stable.
2. Download the tarball, extract `package/tree-sitter-bash.wasm`.
3. `sha256sum` the new file and update this README.
4. Run the conformance suite — node-name renames in the grammar can
   silently break the resolver's whitelist (`TREE_SITTER.md §11.3`).
5. Bump `web-tree-sitter` to a compatible runtime version if needed.

## Current checksum

```
sha256:8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a  tree-sitter-bash.wasm
```
