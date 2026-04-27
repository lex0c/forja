# CLAUDE.md

Instruções pra Claude Code trabalhando no Forja — agentic CLI especificada em `docs/spec/`.

## Premissa raiz

> **Meça duas vezes, corte uma.**

Toda ação com side effect persistente passa por verificação prévia. Toda decisão sobre cortar tem fallback. Toda inferência declara o que **não** mediu (`not_checked`, `assumptions`, `confidence`). Os princípios em `docs/spec/AGENTIC_CLI.md §1` derivam dessa raiz.

## Antes de implementar qualquer subsistema, leia a spec

Spec arquitetural em `docs/spec/AGENTIC_CLI.md`. Cada subsistema tem doc dedicado:

| Implementando | Leia |
|---|---|
| Harness, loop, budget, profiles | `AGENTIC_CLI` §5, `STATE_MACHINE`, `ORCHESTRATION` |
| Tools | `AGENTIC_CLI` §7, `CONTRACTS` §2.6 |
| Provider adapters | `PROVIDERS`, `LOCAL_MODELS`, `AGENTIC_CLI` §14 |
| Permissions | `AGENTIC_CLI` §8 |
| Trust / sandbox / threat model | `AGENTIC_CLI` §9, `SECURITY_GUIDELINE` |
| Hooks | `AGENTIC_CLI` §10, `CONTRACTS` |
| Subagents / playbooks | `AGENTIC_CLI` §11, `PLAYBOOKS` |
| Checkpoints / undo | `AGENTIC_CLI` §12 |
| Storage / schema / audit | `AGENTIC_CLI` §13, `AUDIT` |
| Context engine, compaction | `AGENTIC_CLI` §6, `CONTEXT_TUNING` |
| Sampling, output budgets | `TOKEN_TUNING` |
| UI Ink, microcopy, design tokens | `AGENTIC_CLI` §17, `UI`, `DESIGN_SYSTEM` |
| Memory cross-session | `MEMORY` |
| Recap | `RECAP` |
| Code index (tree-sitter) | `CODE_INDEX` |
| Code generation pipeline | `CODE_GENERATION` |
| MCP | `MCP` |
| Failure handling, recovery | `FAILURE_MODES` |
| Performance budgets, SLOs | `PERFORMANCE` |
| Feature flags | `FEATURE_FLAGS` |
| **O que NÃO fazer** | `ANTI_PATTERNS` (ler antes de propor "feature legal") |

Spec é protocolo, não sugestão. Divergir da spec exige PR contra a spec **primeiro**, código depois. Nunca editar `docs/spec/` sem pedido explícito do usuário.

## Stack travada

- Linguagem: **TypeScript** strict
- Runtime: **Bun** (single-binary via `bun build --compile`)
- Storage: **SQLite via `bun:sqlite`** — SQL cru com tipos, **sem ORM**
- TUI: **Ink** (React no terminal)
- Lint/format: **Biome**
- Test: **`bun test`** (built-in)
- Provider SDKs: `@anthropic-ai/sdk` (M1), `@modelcontextprotocol/sdk` (M3+)

Mudança de stack exige PR contra `docs/spec/AGENTIC_CLI.md §3`.

## Regras absolutas

- **Sem ORM.** SQL cru com tipos.
- **Sem regex em policy/permissions.** Glob + prefix only.
- **Sem vector DB v1.** Sem cargo cult (princípio 12, `ANTI_PATTERNS` §2.2).
- **Sem auto-commit, sem persona tuning, sem prompt-as-IP, sem undercover mode.** Ler `ANTI_PATTERNS` antes.
- **Eval é load-bearing.** Subsistema sem eval não fecha (princípio 4).
- **stdout puro, stderr pra log.** Modo `--json` = NDJSON em stdout, nada mais.
- **Trace tudo.** Sem reproduzibilidade, não existe (princípio 7).
- **Reversível por design.** Toda escrita tem checkpoint (princípio 10).
- **Confiança explícita.** Diretório novo / `AGENTS.md` desconhecido = não-confiável até prova.

## Workflow obrigatório

1. Identificar doc(s) da spec relevantes e ler antes de codar.
2. Atualizar `docs/BACKLOG.md` (entrada nova no topo) **antes** e **depois** do trabalho.
3. Código novo nasce com teste. Sem teste = não tá pronto.
4. Commit: mensagem descreve o **porquê**, não o quê.
5. Branch por milestone (`feat/mN-*`) até estabilizar trunk-based.

## Comandos

- `bun install` — deps
- `bun test` — tests
- `bun run dev` — entrypoint em watch
- `bun run typecheck` — `tsc --noEmit`
- `bun run lint` — Biome check
- `bun run lint:fix` — Biome auto-fix
- `bun run build` — compila binário em `dist/agent`

## Estrutura

```
docs/
  spec/             # spec arquitetural (read-only sem PR de spec)
  BACKLOG.md        # diário de progresso
src/                # subsistemas emergem conforme cada milestone exige
tests/
evals/              # smoke / regression / bench (spec §16)
```

Pastas vazias com `.gitkeep` são ruído — diretórios de subsistema (`src/harness`, `src/tools`, etc) nascem na etapa que escreve código neles.

## Idioma

Specs e `BACKLOG.md` em **PT-BR**. Mensagens de erro user-facing em PT-BR. Identificadores de código, comentários técnicos e nomes de tools em **inglês** (interoperabilidade com providers e MCP).
