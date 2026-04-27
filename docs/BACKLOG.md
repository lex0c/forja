# Backlog

Diário de progresso do Forja. Entradas em ordem cronológica reversa (mais recente no topo).

Formato:

```
## [YYYY-MM-DD] <milestone>/<etapa> — <título>

**Feito:** ...
**Decisões:** ...
**Pendências:** ...
**Próximo:** ...
```

---

## [2026-04-27] M1 / Etapa 1 — Bootstrap do repositório

**Feito:**
- Branch `feat/m1-foundation` criada a partir de `main`.
- `CLAUDE.md` na raiz: premissa raiz, mapa Doc→Subsistema, stack travada, regras absolutas, workflow.
- `docs/BACKLOG.md` (este arquivo).
- `package.json` com scripts (`dev`, `test`, `lint`, `typecheck`, `build`) e bin `agent`.
- `tsconfig.json` strict (incluindo `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- `biome.json` (linter + formatter, 100 col, single quotes, semi).
- `.gitignore` cobrindo runtime state per spec §2.7 (`.agent/sessions.db`, traces, checkpoints, memory local).
- `src/cli/index.ts` stub — responde a `--version` / `-v`; resto sai com exit 1 e ponteiro pra spec.

**Decisões:**
- **Test runner:** `bun test` built-in, não Vitest da spec §16. Razão: alinha com princípio 5 ("single runtime"); zero deps. Revisitar se faltar feature crítica (snapshot multi-arquivo, parallel isolation, etc).
- **Linter:** Biome (single binary, Bun-friendly) em vez de ESLint+Prettier — alinha com "single runtime" também.
- **`docs/BACKLOG.md` em vez de `.txt`** — markdown renderiza no GitHub e mantém consistência com o resto do repo.
- **Branch por milestone** (`feat/mN-*`) até estabilizar trunk-based.
- **Pastas de subsistema não criadas vazias** — emergem na etapa que precisa delas. `.gitkeep` em pastas vazias é ruído.
- **Stack alinhada com spec §3**: TS + Bun + bun:sqlite + Ink. Nenhum desvio.

**Pendências:** rodar `bun install` localmente (depende do ambiente do dev). Confirmar `bun --version >= 1.1`.

**Próximo:** Etapa 2 — Storage layer (SQLite) com schema mínimo do `AGENTIC_CLI §13`: tabelas `sessions`, `messages`, `tool_calls`, `approvals`, `checkpoints`, `traces`. Migrations infra. Repository pattern fino sobre `bun:sqlite`. Testes de schema + CRUD básico.
