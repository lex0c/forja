# forja

Agentic CLI — terminal-first, multi-provider, self-hostable.

```bash
npm i -g @lex0c/forja
forja --version
```

The command installed is `forja` (the `@lex0c/` scope only affects the
package name, not the command). Installing pulls a tiny launcher plus the
prebuilt binary for **your** platform — one `optionalDependency`, gated by
`os`/`cpu`, so other platforms' binaries are never downloaded.

Supported platforms: `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`, `windows-x64`.

## Other install methods

The binaries are also published on
[GitHub Releases](https://github.com/lex0c/forja/releases) — each carries
`SHA256SUMS`, a CycloneDX SBOM, and SLSA build provenance. The
[`install.sh`](https://github.com/lex0c/forja#get-started) one-liner is the
fail-closed verified install:

```bash
curl -fsSL https://raw.githubusercontent.com/lex0c/forja/main/install.sh | sh
```

The npm packages carry the **same** binaries (byte-identical, re-verified
against `SHA256SUMS` at publish time) and are published with npm provenance.

## License

Apache-2.0. See the [repository](https://github.com/lex0c/forja).
