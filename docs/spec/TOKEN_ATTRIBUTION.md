# TOKEN_ATTRIBUTION

Subsistema de atribuição de tokens por tool call. Captura, para cada `tool_use` da sessão, quantos tokens entram no histórico via `tool_result` e quantos saem na emissão da própria call — operador responde "qual tool drenou o budget desta sessão?" sem inferir do log de mensagens.

> Sem attribution, custo agentic é uma caixa preta: o operador vê `$0.42` no footer mas não sabe se foi a busca de retrieval, o grep gigante, o read de um arquivo de 8k linhas, ou o subagent que rodou em loop. Com attribution mal feito (proporcional, presumido, agregado por step), o número some no agregado e perde a granularidade que motivou a feature.

`TOKEN_TUNING.md` cobre tokenizer accuracy e budget global; `PERFORMANCE.md` cobre o orçamento por turno. Este doc cobre **atribuição** — quem pagou o quê dentro de um turno.

---

## 0. Princípios (não-negociáveis)

1. **Atribuição é por tool_use, não por tool name.** A call concreta (`tu_01ABC...`) carrega seus números. Agregar por `tool_name` é um VIEW, não a forma de armazenamento.
2. **Best-effort, nunca load-bearing.** Falha na escrita da linha de attribution não falha o tool. O subsistema é forense — perda silenciosa de uma linha vira gap aceito em `agent stats --tools`, não tool error.
3. **Direto, não compounding.** Cada linha representa o custo DIRETO do tool nessa step. O fato de que um `tool_result` de 3k tokens é bilhado em TODOS os turnos subsequentes (até compaction) é um VIEW computado pela CLI, não persistido por step.
4. **Tokens estimados, não bilhados.** O provider só reporta `usage` agregado por mensagem; atribuir o split exato é impossível sem proporcionalização. Storage carrega ESTIMATIVAS via `estimateTextTokensFor(family, content)` — mesma função que alimenta o chip live e o discrepancy detector.
5. **Cost só quando reconcilia.** `estimated_cost_usd` é opcional na linha. Quando presente, é derivado pela `computeCost(capabilities, usage)` aplicada ao SLICE estimado do total. Quando ausente, leitor calcula on-demand via lookup do `messages.created_at` + `sessions.model`.
6. **Sem dedup de content.** Dois `tool_result` com o mesmo content tokenizam ao mesmo número; armazenamos as duas linhas independentes. Compactação cross-call viraria attribution baseada em equivalência semântica — fora do escopo.
7. **Append-only, sem update.** A linha é insertada UMA vez por `tool_use_id`. Re-execução do mesmo tool (retry, redo) cria nova linha com `step_n` diferente. Update silenciaria a história.

---

## 1. Modelo de dados

### 1.1 Tabela

Adicionada via migration em `src/storage/migrations/<N>-tool-token-attributions.ts`:

```sql
CREATE TABLE tool_token_attributions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_n                INTEGER NOT NULL,
  tool_use_id           TEXT    NOT NULL,                -- ULID/correlation id do provider
  tool_name             TEXT    NOT NULL,                -- 'bash' | 'read_file' | ...
  result_input_tokens   INTEGER NOT NULL,                -- estimativa do tool_result content
  call_output_tokens    INTEGER NOT NULL,                -- estimativa do bloco tool_use (name + args)
  estimated_cost_usd    REAL,                            -- opcional; preenche quando reconcilia
  created_at            INTEGER NOT NULL,                -- ms since epoch, stamp pós-execução
  UNIQUE(tool_use_id)
);
CREATE INDEX tool_token_attributions_by_session_step
  ON tool_token_attributions(session_id, step_n);
CREATE INDEX tool_token_attributions_by_tool_name
  ON tool_token_attributions(session_id, tool_name);
```

`UNIQUE(tool_use_id)` é a defesa contra double-insert (`invoke-tool.ts` rodando duas vezes pra mesma call em retry path). `INSERT OR IGNORE` — segunda escrita silenciada, não erro.

`ON DELETE CASCADE` em `session_id`: quando a sessão é deletada (purge, retenção, operator delete), as linhas de attribution vão junto. Sem orphans.

### 1.2 Campos

| Coluna | Significado | Fonte |
|---|---|---|
| `result_input_tokens` | Tokens do `tool_result.content` que entram no histórico | `estimateTextTokensFor(family, tool_result.content)` |
| `call_output_tokens` | Tokens que o assistant gastou emitindo o `tool_use` block | `estimateTextTokensFor(family, tool_name) + estimateTextTokensFor(family, JSON.stringify(args))` |
| `estimated_cost_usd` | Custo derivado dessas duas contagens | `computeCost(capabilities, { input: result_input_tokens, output: call_output_tokens, ... })` |

**Por que não usar `usage.output_tokens` diretamente?** O provider reporta `usage` por MENSAGEM, não por bloco. Uma assistant turn que emite `text + tool_use_A + tool_use_B` tem um único `output_tokens` agregado; splitar proporcionalmente daria a impressão de precisão sem aumentar o sinal. Estimar via tokenizer da família do provider é tão exato quanto o split proporcional, mas honesto sobre a fonte.

### 1.3 Retenção

Mesma política das `messages` (AGENTIC_CLI §13). Quando session é purgada ou expira o cap configurado, attributions descem junto via CASCADE.

`agent stats --tools` lê dados COM uma sessão ainda viva. Não há archive de attributions independente.

---

## 2. Captura

### 2.1 Site

`src/harness/invoke-tool.ts`, após `tool_result` ser construído e ANTES de ser appendado ao `messages` array em memória. O dispatch:

```ts
// pseudocódigo — concrete signature definida no slice de implementação
const attribution: ToolTokenAttribution = {
  session_id: ctx.sessionId,
  step_n: ctx.stepN,
  tool_use_id: toolCall.id,
  tool_name: toolCall.name,
  result_input_tokens: estimateTextTokensFor(family, toolResult.content),
  call_output_tokens:
    estimateTextTokensFor(family, toolCall.name) +
    estimateTextTokensFor(family, JSON.stringify(toolCall.args)),
  estimated_cost_usd: computeCost(provider.capabilities, /* slice */),
  created_at: Date.now(),
};
appendToolAttribution(db, attribution); // try/catch best-effort
```

**Erro na escrita**: logado em `stderr` (forja: failed to persist tool_token_attribution for tu_X: ...), tool continua normalmente. NÃO emite `failure_events` (subsistema próprio, mas reservado pra falhas com cost operacional — atribuição perdida é gap, não falha).

### 2.2 Edge cases

- **Tool denied**: tool_result existe (`is_error: true, content: 'denied by policy'`), mas o content é curto. Attribution é registrada com `result_input_tokens` pequeno; `call_output_tokens` reflete o bloco que o modelo emitiu (e foi negado, mas o output já saiu da boca do modelo).
- **Tool error**: idem denied. O erro é content; tokeniza normalmente.
- **Subagent task**: o `task` tool tem `tool_result` que pode ser grande (output do subagent). Attribution é da CALL — quem fez `task` paga pelo tool_result inteiro. O subagent INTERNO produz attributions próprias na sua session_id; cross-correlation via `subagent_handles.parent_session_id` (subsistema de subagent IPC).
- **Cancelled mid-execution**: nenhuma `tool_result` foi appendada → nenhuma attribution. Sessão registra `tool_calls.status='cancelled'` (via outro subsistema) mas attribution não é forjada.
- **Memory tools** (`memory_read`, `memory_write`): seguem o mesmo path. `result_input_tokens` reflete o content carregado/persistido; útil pra debugar "essa memory entry está pesando X% do prompt".

### 2.3 Throughput

Cada tool call → 1 INSERT. Em sessões com paralelismo (tool dispatcher), o batch INSERT é por-call, sequencial dentro de uma transação. SQLite handle: irrelevante (<<1ms por INSERT, INSERT OR IGNORE não bloqueia ler).

---

## 3. API

`src/storage/repos/tool-token-attributions.ts`:

```ts
appendToolAttribution(db: DB, row: ToolTokenAttributionInput): void
// INSERT OR IGNORE; silently no-ops on UNIQUE conflict.

listToolAttributionsBySession(db: DB, sessionId: string): ToolTokenAttributionRow[]
// ORDER BY step_n ASC, created_at ASC.

aggregateToolAttributionsByName(db: DB, sessionId: string): ToolAttributionAggregate[]
// GROUP BY tool_name; columns: tool_name, calls, total_result_input, total_call_output, total_cost_usd.

aggregateToolAttributionsGlobal(db: DB, opts?: { since?: number; limit?: number }):
  ToolAttributionGlobalAggregate[]
// Cross-session aggregation for `agent stats --tools --all`.
// `since`: ms epoch lower bound on created_at.
```

Sem SUBQUERY recursiva nem cursor — todas as queries são SELECT planos com agregações terminais. Sem complexidade que merece ORM.

---

## 4. CLI surface

### 4.1 `agent stats --tools` (per-session default)

```text
$ agent stats --tools
session sess-2025-12-01-abc  · sonnet-4.6 · 5m23s · 12 steps · $0.42

  tool                  calls  result_in   call_out   est_cost
  bash                     8     18.4k       420       $0.082
  read_file               14      3.2k       180       $0.014
  grep                     6      2.1k        92       $0.009
  task                     2      1.4k        80       $0.018
  ────────────────────────────────────────────────────────────
  total                   30     25.1k       772       $0.123
```

- Ordenação por `result_input_tokens` desc (impacto em context).
- `est_cost` pode estar incompleto (algumas linhas sem `estimated_cost_usd`); rodapé indica `(2 calls com cost estimado on-the-fly)`.
- `--session <id>`: alterna pra sessão específica em vez do current.
- `--all`: agrega cross-session (`aggregateToolAttributionsGlobal`).
- `--since <duration>`: filtra (`--since 7d`, `--since 24h`).
- `--by tool|step|cost`: muda ordenação.

### 4.2 `agent stats --tools --step <N>`

Drill-down num step específico:

```text
$ agent stats --tools --step 7
session sess-... step 7

  tool_use_id                 tool      result_in   call_out   est_cost
  tu_01ABC                    bash         12.4k      120       $0.058
  tu_01DEF                    read_file     3.2k       80       $0.013
  ────────────────────────────────────────────────────────────────────
  total                                    15.6k      200       $0.071
```

Útil quando o operator percebe um step com burn alto e quer saber qual call específica disparou.

### 4.3 Output design

stdout = NDJSON em `--json`, conforme princípio raiz "stdout is pure, stderr is for logs". Tabela acima é o modo human-readable (default em TTY); `--json` despeja uma linha por agregado.

---

## 5. UI surface

**Defer ao primeiro slice.** A live region já tem tool cards (UI.md §4.10.5); adicionar attribution inline (`▸ Read file [42ms · +3.2k tokens]`) é tentador mas explode a largura da chip em terminals < 100 cols. Esperar feedback de uso pelo CLI antes de comprometer com expansão da chip.

Quando landar: candidato natural é uma expansion `Ctrl+O` sobre o card (já reservado pra "output truncated, ctrl+o to expand" — mesma tecla, expansão estendida). Operador clica e vê:

```
  ● Read file  [42ms]
  └─ src/foo.ts:1-2000
     +3.2k context tokens (estimated)
```

Decisão final pós-validação de operadores reais.

---

## 6. Privacy e retention

### 6.1 Conteúdo armazenado

A tabela carrega **apenas contagens**, nunca content. O `tool_result.content` já está em `messages`; replicar viraria duplicação útil-zero. Forensics que precisa do content recupera via `messages.content` JOIN tool_use_id.

### 6.2 Operator-facing zero

Sem PII, sem secrets, sem fragmentos de path. As contagens são números puros — nada que `agent stats` despeje em stdout precisa ser sanitizado.

### 6.3 Retention

Cascade via `session_id`. Operator deleta sessão → attributions descem. Sem TTL próprio.

---

## 7. Erro handling

| Cenário | Comportamento |
|---|---|
| INSERT falha (disk full, lock contention) | stderr log; tool prossegue; attribution perdida pra essa call |
| Tokenizer throw (encoder corrupto) | catch + log; row gravada com `result_input_tokens=0` ou skipped (decidir no slice) |
| `tool_use_id` duplicado (retry path) | INSERT OR IGNORE — primeira escrita venceu |
| Cross-session leak (session_id wrong) | FK check pega no INSERT; row rejeitada; log |
| Stats com tabela vazia | "no attribution data for session X" em info-line |

---

## 8. Não-objetivos

- **Não substitui `messages.tokens_in/tokens_out`.** Aqueles são per-mensagem agregados do provider; este é per-tool estimado.
- **Não rastreia retrievals como tool.** Retrieval é parte do step pipeline (RETRIEVAL.md), não tool no sentido AGENTIC_CLI §7. Quando retrieval virar `retrieve_context` tool (subsistema atual), aí entra no fluxo.
- **Não atribui memory por turno.** Memory é uma camada de input que vive ao lado das messages; sua attribution é coberta por `MEMORY.md §provenance`, não aqui.
- **Não faz previsão / forecasting.** "Quanto vai custar a próxima call" é fora — a chip live tem o projection no footer (`cost → ~$X`). Attribution é histórica.

---

## 9. Cross-references

- `AGENTIC_CLI.md §7` — tool system + dispatch site (`invoke-tool.ts`).
- `AGENTIC_CLI.md §13` — modelo de dados; tabela registrada lá.
- `TOKEN_TUNING.md §8` — tokenizer accuracy; mesma `estimateTextTokensFor` alimenta input/output dessas linhas.
- `PERFORMANCE.md` — budget global; attribution é refinamento per-call.
- `CONTRACTS.md §2.6` — output design CLI (`agent stats --tools`).
- `FAILURE_MODES.md` — falha de attribution NÃO emite `failure_events`; é gap aceito.
- `IPC.md` — subagent attribution: linha vai pra session do PAI quando o `task` tool é invocado; subagent INTERNO produz attributions na sua session.
