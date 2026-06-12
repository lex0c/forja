# ORCHESTRATION

Coordenação de timing entre subsistemas do `AGENTIC_CLI`. Este doc é a **autoridade operacional** para perguntas "quando X roda relativo a Y".

`AGENTIC_CLI.md` é spec arquitetural (**o quê**). Este doc é spec operacional (**quando**, em que ordem, com que paralelismo, com que cancellation).

Sem timing explícito, dois implementadores divergem silenciosamente — bugs sutis em prod. Este doc resolve as ambiguidades.

---

## 0. Princípios

1. **Toda coordenação é explícita.** Sem timing implícito.
2. **Cancellation é paralela**, não sequencial. Wall-clock total bound.
3. **Concorrência é declarada**, nunca emergent.
4. **Compaction é entre steps**, nunca no meio.
5. **Hooks bloqueáveis e não-bloqueáveis** têm path distinto.
6. **Subagent semantics** depende da tool (sync vs async).
7. **Budget é compartilhado**, não pre-alocado.
8. **Decisões de timing honram a premissa raiz** — meça duas vezes (validators, hooks, critique), corte uma (single execution path).

---

## 1. Master loop (autonomous profile)

Diagrama com pontos de hook anotados:

```
┌─────────────────────────────────────────────────────────────┐
│ user_prompt received                                         │
│      ↓                                                       │
│ [SessionStart hooks] (if first turn) — BLOCKING              │
│      ↓                                                       │
│ [UserPromptSubmit hooks] — BLOCKING (block possível)         │
│      ↓                                                       │
│ ┌─ Step Loop ─────────────────────────────────────────────┐  │
│ │ Step N start (tx SQLite begin)                           │  │
│ │     ↓                                                    │  │
│ │ Context assembly                                         │  │
│ │     ↓                                                    │  │
│ │ Compaction check (token count vs 70% threshold)          │  │
│ │     ├─ trigger: PreCompact hook → compact (§4)           │  │
│ │     └─ continue                                          │  │
│ │     ↓                                                    │  │
│ │ Provider call (stream)                                   │  │
│ │     ↓                                                    │  │
│ │ Parse: text + tool_use blocks                            │  │
│ │     ↓                                                    │  │
│ │ if tool_use proposed:                                    │  │
│ │   [PreToolUse hook] — BLOCKING (deny possível)           │  │
│ │     ↓                                                    │  │
│ │   Permission check (allow/deny/confirm)                  │  │
│ │     ↓                                                    │  │
│ │   if writes: true → [PreCheckpoint hook] → snapshot      │  │
│ │     ↓                                                    │  │
│ │   Tool execute (with AbortSignal)                        │  │
│ │     ↓                                                    │  │
│ │   Output sanitization (ANSI strip, secret redact)        │  │
│ │     ↓                                                    │  │
│ │   [PostToolUse hook] — FIRE-AND-FORGET                   │  │
│ │     ↓                                                    │  │
│ │   Tool result → context                                  │  │
│ │     ↓                                                    │  │
│ │ if no tool_use (model emitted stop):                     │  │
│ │   [Self-critique pass] (if mode applicable, §6)          │  │
│ │     ↓                                                    │  │
│ │   Persist final assistant message                        │  │
│ │     ↓                                                    │  │
│ │ Step done (tx SQLite commit) → idle                      │  │
│ └──────────────────────────────────────────────────────────┘  │
│      ↓                                                       │
│ [Stop hook] (em fim de sessão) — BLOCKING                    │
└──────────────────────────────────────────────────────────────┘
```

### 1.1 Insertion points formalizados

| Ponto | Tipo | Bloqueia loop? | Pode cancelar ação? |
|---|---|---|---|
| `SessionStart` | hook | sim | não (no-op em block) |
| `UserPromptSubmit` | hook | sim | sim (rejeita prompt) |
| Compaction trigger check | check determinístico | sim (suspende step) | não |
| `PreCompact` | hook | sim | sim (cancela compaction) |
| Compaction LLM call | call | sim (próximo step espera) | não |
| `PreToolUse` | hook | sim | sim (nega tool) |
| Permission engine | check | sim | sim (deny por policy) |
| `PreCheckpoint` | hook | sim | não |
| Checkpoint snapshot | FS atomic op | sim (atomicidade) | não |
| Tool execute | runtime | sim (até retorno ou abort) | n/a (já executando) |
| Output sanitization | filtro | sim (~ms) | não |
| `PostToolUse` | hook | **não — fire-and-forget** | não |
| Self-critique | LLM | sim (opt-in) | sim (block persist) |
| `Notification` | hook | não — fire-and-forget | não |
| `MemoryWrite` | hook | sim | sim (bloqueia write) |
| `Stop` | hook | sim | não |

### 1.2 Atomicidade transacional

Cada step é uma **transação SQLite**. Begin no start, commit no done. Crash mid-step:
- INSERT/UPDATE rolled back
- State machine §7 cuida do recovery

Compaction também é transação (§4.3).

### 1.3 Multi-tool-use em único step

Modelos modernos (Anthropic, OpenAI) podem emitir **múltiplos tool_use blocks** em uma única assistant message. Comportamento:

- **Default: sequencial** na ordem emitida pelo modelo
- Cada tool é unidade independente: falha de A **não cancela** B
- `PreToolUse` hook dispara **N vezes** (uma por tool); permission engine roda **por tool**
- Single step contém todos os pares tool_use+tool_result; commit no fim
- Tool_result no contexto na **mesma ordem** dos tool_use (Anthropic respeita; outros providers normalizam)

**Opt-in paralelismo:** tool definition pode declarar `parallel_safe: true` (read-only tools). Se **todos** tool_use no mesmo step são `parallel_safe`, harness roda em paralelo (limite `max_concurrent_tool_calls`). Default: sequencial. Tools com `writes: true` **nunca** rodam paralelo (race em FS).

```ts
interface Tool {
  // ... existing fields
  parallel_safe?: boolean   // default false; só read-only tools devem declarar true
}
```

### 1.4 Thinking tokens (extended thinking)

Anthropic com thinking enabled (Opus 4.x) emite `thinking_delta` antes do output. OpenAI `o1`/`o3` têm reasoning tokens não-streamáveis. Comportamento:

- **Display default: oculto.** Thinking não aparece no main view; toggle via `--show-thinking` ou `/thinking on`
- **Cost:** span próprio em traces (`reasoning.cost_usd`); **somado** ao step.cost_usd no `/cost` total mas linha separada no breakdown
- **Persistence em `messages`:** **NÃO** persiste (não-reprocessável em retry; provider gera novo a cada call)
- **Compaction:** descarta automaticamente (não vai pro summary)
- **Replay:** re-gera (não-determinístico mesmo com `temperature=0`)

UI: thinking indicator opcional na status line mostra `thinking... (12s)` durante `thinking:delta` events (ver UI.md §3.2). Some quando output começa.

### 1.5 Provider error mid-stream

Provider retorna 5xx ou stream cuts mid-output. Comportamento:

- **Partial output descartado** — não persiste em `messages`
- **Cost dos partial tokens:** registrado em `failed_attempts.cost_usd` (separado de `step.cost_usd`); aparece em `/cost` como linha de waste
- **Retry:** backoff exponencial 200ms/800ms/3.2s; até 3 tentativas
- **UI feedback:** rodapé mostra `↻ retry 1/3 (provider 5xx)` discreto
- **Idempotency:** novo request usa **mesma conversation history**; não há seed; modelo regera de forma independente (esperado, aceito)
- **3 retries falham:** step marcado `error`; modelo **não recebe** o erro como tool_result (não é tool error); sessão pode entrar em `error_fatal` ou aguardar user (depende do FAILURE_MODES.md §2.1-2.3)

### 1.6 Loop degenerado detection

Além de `maxToolErrors` (5 erros consecutivos), harness detecta **loop degenerado** por padrão repetitivo:

- **Mesma tool com mesma input hash** invocada 3× em 5 steps consecutivos → `degenerate_loop` warning
- 5 erros em 7 steps consecutivos (qualquer tool) → `exhausted_errors`
- Action em qualquer detection: aborta loop com mensagem clara ao user; sessão entra em `error` (recoverable via resume)

Hash da input: SHA256 de `JSON.stringify(args, sortedKeys)`. Persistido em `tool_calls.input_hash` pra detecção rápida.

---

## 2. DAG execution model (orchestrated profile)

DAG é alternativa ao step loop. Mesmas primitivas (hooks, permissions, checkpoints), orquestração diferente.

### 2.1 Lifecycle de um DAG run

```
┌──────────────────────────────────────────────────┐
│ DAG load + validate (cycles, orphans, schemas)   │
│      ↓                                            │
│ [SessionStart hooks if first turn]                │
│      ↓                                            │
│ Topological sort                                  │
│      ↓                                            │
│ ┌─ Wave Schedule Loop ────────────────────────┐   │
│ │ Para cada wave (nodes ready):               │   │
│ │   spawn N nodes em paralelo (max_concurrent)│   │
│ │     ↓                                        │   │
│ │   execute_node(N) cada                       │   │
│ │     ↓                                        │   │
│ │   Persist node output (tx SQLite)            │   │
│ │     ↓                                        │   │
│ │   Aguarda toda wave completar                │   │
│ │     ↓                                        │   │
│ │   on_node_failure: aplica policy             │   │
│ │     ↓                                        │   │
│ │   Próxima wave                               │   │
│ └─────────────────────────────────────────────┘   │
│      ↓                                            │
│ Aggregate output                                  │
│      ↓                                            │
│ [Stop hook]                                       │
└──────────────────────────────────────────────────┘
```

### 2.2 Node execution detail

```
execute_node(N):
  if N.type == llm:
    Provider call (constrained se outputSchema declarado)
      ↓
    if tool_use proposed: dispatch via master loop tool flow (§1)
      ↓
    Validators (sequential, fast first)
      if any fatal: failed
      if any non-fatal + retries left: retry with hint (max_retries)

  if N.type == deterministic:
    Execute fn (puro TS)
      ↓
    Validators

  if N.type == tool:
    Permission check + checkpoint + execute (master loop tool flow)

  if N.type == subgraph:
    Recursive execute_dag (inline expansion, §9)
```

### 2.3 Paralelismo declarado

Header do DAG:

```yaml
execution:
  max_concurrent: 3                # default 3; cap 8 (§11)
  on_node_failure: continue | abort_siblings | abort_dag
  fail_strategy: fast | greedy
```

Defaults: `max_concurrent=3`, `on_node_failure=abort_siblings`, `fail_strategy=fast`.

**Comportamento:**
- Nodes sem dependência ⇒ rodam em paralelo até `max_concurrent`
- Nodes com dependência ⇒ aguardam predecessores
- `fast`: aborta wave atual no primeiro fail
- `greedy`: deixa wave terminar mesmo com fails (útil pra evals)

### 2.4 Per-node budget

```yaml
- id: locate
  type: llm
  budget:
    max_tokens: 4000
    timeout_ms: 30000
    max_retries: 2                 # default 2
    max_cost_usd: 0.05             # opcional; herda do DAG global
```

Default herda do DAG-level budget se ausente. DAG global herda da sessão.

### 2.5 Crash mid-DAG

Crash do executor com DAG em execução:

| Estado pré-crash | Recovery |
|---|---|
| Node em `done` (output persisted) | preservado |
| Node em `executing` | descartado; re-executa no resume |
| Node em `validating` | output buffer descartado; re-executa node |
| Node em `retrying` | retry counter preservado em SQLite; continua |

Nodes determinísticos são **idempotent by definition**; LLM nodes regeneram (custo extra aceito).

---

## 3. Subagent spawn semantics

### 3.1 Duas tools distintas

```ts
task_sync(playbook: string, prompt: string, budget?: Budget): SubagentOutput
task_async(playbook: string, prompt: string, budget?: Budget): SubagentHandle
task_await(handle: SubagentHandle, timeout_ms?: number): SubagentOutput
task_cancel(handle: SubagentHandle): void
```

`task` (alias legado) = `task_sync`.

### 3.2 Sync vs async

| Tool | Pai bloqueia? | Uso |
|---|---|---|
| `task_sync` | sim, até subagent terminar | default; coordenação simples |
| `task_async` | não; retorna handle imediato | múltiplos subagents paralelos |

### 3.3 Paralelismo

Step do pai pode emitir múltiplos `task_async()` em sequência:
1. Cada um spawna subagent **imediato**
2. Limite global `max_concurrent_subagents = 3` (default; cap 8)
3. Excedeu: spawn aguarda slot livre (não rejeita)

`task_sync` em sequência ⇒ subagents **sequenciais** (latência soma). Pra paralelismo: `task_async`.

### 3.4 Coleta de outputs

Pattern típico paralelo:

```ts
const h1 = task_async("explore", "find auth files");
const h2 = task_async("explore", "find queue files");
const h3 = task_async("explore", "find migrations");
const [out1, out2, out3] = await Promise.all([h1, h2, h3].map(task_await));
```

Pai vê **só os outputs finais**. History intermediária dos subagents nunca chega ao pai (§11.1 do AGENTIC_CLI.md — contexto isolado).

### 3.5 Budget shared

Cap de cost (`maxCostUsd` do `RunBudget`) é **compartilhado** entre o pai e seus filhos `task_async`. O contrato:

- Pai tem `$cap` total — **único hard cap** que mata um run mid-flight.
- `priorCostUsd + totalCostUsd` rastreia spend do pai (próprias provider calls + compaction calls)
- Cada filho settled contribui com seu `costUsd` real ao tracker compartilhado
- Cada filho **in-flight** contribui com sua **reserva pessimista**: `definition.budget.maxCostUsd` (worst-case declarado pelo playbook)
- `task_async` pré-checa: se `parentSpend + settledChildCost + reservedChildCost + novaReserva > cap`, refusa com `subagent.budget_exhausted` (`SubagentOutput.reason` em `CONTRACTS.md §2.6.4.1`)
- Reserva libera quando o filho settla; spend real do filho então conta direto
- **Operator opt-out:** se o pai tem `maxCostUsd === undefined` (operador desabilitou via `/budget cost off`, ver `AGENTIC_CLI.md §5`), todos os gates desta seção viram no-op — não há cap pra projetar contra. Filhos herdam o mesmo opt-out via snapshot do `audit.budgetMaxCostUsd`. Esta é uma ação deliberada do operador, registrada em audit; o threat model `SECURITY_GUIDELINE.md §1.5` cobre por que não é vulnerabilidade (loop/modelo/repo malicioso não consegue escrever em `baseConfig.budget`).

#### 3.5.0 Per-playbook cap é soft, não hard

O `definition.budget.maxCostUsd` declarado no frontmatter de um playbook (ex: `explain.md` com `max_cost_usd: 1.00`) tem **duas funções distintas** que merecem nomes distintos:

1. **Reserva pessimística pré-spawn** — quanto o pai precisa "guardar" no orçamento global ao admitir esse spawn. Continua hard-load-bearing pra impedir over-commit no momento do spawn (§3.5.1, §3.5.2).
2. **Sinal de regressão durante execução** — "esse playbook normalmente custa até X; se ele cruzou X, está fora do esperado". Soft, NÃO mata o run.

Quando o filho ativo cruza o **per-playbook cap** mid-run:
- O harness do filho emite um `HarnessEvent` `cost_soft_cap_warn { threshold, cumulative }` uma vez (idempotent — não re-emite a cada novo cost_update). O evento atravessa o canal IPC `event` (`IPC.md`) e o pai o desembrulha via `subagent_progress.lastEvent`; o `subagentId`/`handleId` é decoração do pai (vem do envelope `subagent_progress`), não viaja dentro do payload do evento.
- Renderiza no scrollback como aviso ao operador: `subagent <id-prefix> over budget estimate ($X.XX > $Y.YY)` (ou sem prefixo, em runs top-level).
- O run **continua** até o pai-side hard cap (§3.5.2) ou até o término natural.

Isto é uma mudança consciente vs versões anteriores que matavam o filho com `exhausted/maxCostUsd` quando ele cruzava o per-playbook cap. A motivação: o cap de playbook é estimativa de custo, não SLO. Mata-lo no cruzamento gerava "filho morreu por estourar 30¢ de cap quando o pai tinha $4 disponíveis" — falso positivo que descartava trabalho útil. O global cap continua sendo o gate real, e o pai-side watchdog (§3.5.2) garante que cumulative cruzar global derruba todos os filhos.

**Trade-off honesto:** um playbook com cap declarado bem abaixo do uso real não para mais sozinho — pode consumir até o global cap. Mitigação: soft-cap warn é visível ao operador (não é silenciado) e o pai-side watchdog mantém o teto absoluto. Calibração de caps por playbook continua útil como sinal de regressão, mas não é mais ponto único de falha.

#### 3.5.1 Cost-progress via IPC

O filho emite um `HarnessEvent` `cost_update { delta, cumulative }` após cada provider call (turn settle, compaction, partial provider-error). O canal IPC `event` envelopa o evento; o runtime do pai forward via `subagent_progress.lastEvent`. O `spawnSubagentImpl` no pai intercepta e chama `subagentHandleStore.recordLiveCost(handleId, cumulative)` — que atualiza um campo `liveCostUsd` per-record monotonically (eventos out-of-order não regridem).

A reserva por handle é `max(estimateCostUsd, liveCostUsd)`:

- **Antes do primeiro `cost_update`** (bootstrap window): reserva = `definition.budget.maxCostUsd` (worst-case declarado pelo playbook). Sem isto, três `task_async` concorrentes cada um veria `liveCostUsd = 0` (filhos ainda não reportaram) e o cap seria cruzado antes do primeiro `cost_update` chegar. A janela bootstrap é unavoidable mesmo com IPC: existe um delay físico entre spawn e primeiro provider turn.
- **Após `cost_update`**: reserva tracks o gasto real. Se filho excede sua própria budget (`liveCostUsd > estimateCostUsd`), a reserva cresce com o real — não é silenciada.
- **Cancelled** (`cancel`/`cancelAll`): reserva → 0 imediatamente. O record permanece `'running'` até a IIFE settlar, mas `getReservedChildCostUsd` filtra rows com flag `cancelled` para não contar. Eventos `cost_update` em vôo após o cancel são no-op para evitar reativar a reserva.
- **Settled**: reserva → 0; o cost real (`result.costUsd`) flui para `cumulativeChildCostUsd`.

Reconciliação com `§0` princípio 7 ("Budget é compartilhado, não pre-alocado") e `§12` anti-pattern: o `estimateCostUsd` floor NÃO é pre-alocação no sentido do anti-pattern (que ali se refere a "reservar 1/N do cap por subagent paralelo"). É um **placeholder pessimista de duração curta** (até primeiro `cost_update` arrival, tipicamente milissegundos). Após o primeiro report, o tracker é puro live-shared. A janela bootstrap mantém a invariante "novos spawns não over-committam no momento de issue"; sem ela, a leitura literal "competindo" tem o footgun de over-commit transient documentado acima.

#### 3.5.2 Falhas no cap

A tabela abaixo refere-se ao **global cap** (parent's `maxCostUsd`). O per-playbook cap é soft (§3.5.0) — não aparece aqui.

| Hit | Comportamento |
|---|---|
| Pré-spawn projetado > cap | `task_async` (e `task_sync`/dispatcher) retornam `subagent.budget_exhausted`. Reserva soma de in-flight + estimate do novo spawn impede over-commit no momento do spawn. |
| Filho ativo cruza global cap mid-run (cumulative) | A cada `cost_update` recebido, watchdog em `spawnSubagentImpl` projeta `priorCostUsd + totalCostUsd + cumulativeChildCostUsd + getReservedChildCostUsd()`. Se > cap, dispara `subagentHandleStore.cancelAll()` — todos os filhos ativos recebem hard-signal via per-handle controller, gracefully terminam via interrupt:hard IPC. |
| Pai self-cost cruza cap | `runAgent.costCapDetailIfExceeded()` finaliza com `maxCostUsd` no próximo turn boundary. Inclui cumulative + reserved ao computar (consistente com pré-spawn gate). |
| Filho cruza per-playbook cap (soft) | `cost_soft_cap_warn` event emitido uma vez; run continua. Ver §3.5.0. |

#### 3.5.3 Audit

Recusa de spawn com `budget_exhausted` é registrada como tool error normal em `tool_calls`. Não há entry separada em `failure_events` para esse caso (caller pode rastrear via `error_code = 'subagent.budget_exhausted'` em queries de audit).

### 3.6 Cancel cascading

`task_cancel(handle)` ou Ctrl+C no pai:
- SIGTERM no subagent
- 5s graceful → SIGKILL
- Worktree (se isolation) cleanup
- `task_await` retorna `{ status: 'interrupted', ... }`

Cancel é paralelo (§7).

---

## 3B. Background process lifecycle (persistente + notify + wake)

> **Status:** proposta. Reescreve a semântica operacional de `bash_background` (`AGENTIC_CLI.md §7.3`, `CONTRACTS.md §2.6.5d`). **Cross-refs:** `BgManager` injetável espelha o padrão `todoStore` (`AGENTIC_CLI.md §11` injeção session-scoped); envelope de notificação em `CONTRACTS.md §2.6.5d`; transição `idle → running` por wake em `STATE_MACHINE.md §2.2`/§9; inbox in-memory em `MEMORY.md`; cancellation em §7; limites em §11; flag em `FEATURE_FLAGS.md`.

**Problema.** `bash_background` é uma tool de background que, hoje, **não roda em background de verdade**: o `BgManager` é criado por `runAgent` (por-turn) e seu `cleanup()` mata todos os processos no outer finally de **cada turn**. Um processo "em background" morre quando o turn fecha — o propósito da tool é anulado. Esta seção corrige isso: o processo roda genuinamente em background, sobrevive ao turn, e **notifica o modelo** quando termina, em vez de exigir que ele lembre de pollar com `bash_output`.

Diferença de escopo vs `task_async` (§3): aquilo é paralelismo de **subagents** (LLM filhos) dentro de um turn; isto é o lifecycle de **processos de shell** que atravessam turns. Não há tool nova nem flag de modo — é a `bash_background` cumprindo o que o nome promete.

### 3B.1 Lifecycle cross-turn

O `BgManager` passa de **per-`runAgent`** a **session-scoped**: o REPL constrói um no boot e o injeta em cada turn (mesmo padrão de `todoStore`/`contextPinsStore`). `cleanup()` deixa de rodar no fim do turn — roda só no **exit da sessão**. Um processo vive até um destes:

| Gatilho | Efeito |
|---|---|
| Fim **normal** do turn | **sobrevive** — segue rodando |
| Término natural do processo | settla → notificação (§3B.3) |
| `bash_kill(process_id)` | SIGTERM → 5s → SIGKILL; settla com `status: killed` |
| Ctrl+C no turn (interrupt) | **sobrevive** — interrupt do turn não recebe AbortSignal (§7.1, comportamento já existente) |
| Ctrl+C 3× / exit do agente | `cleanup()` mata os sobreviventes — fim da **sessão/processo** |

Escopo é **cross-turn, não cross-process**: o processo morre com o agente (não é daemon). Isto preserva a filosofia "nada de background cross-session" (`AGENTIC_CLI.md §0`) — a sessão REPL é um único processo; nada sobrevive ao seu exit. Em **one-shot** (`run.ts`, não-REPL) não há próximo turn: o `BgManager` é per-run e `cleanup()` roda no fim, como hoje.

### 3B.2 Output durável e recuperação

Nenhum storage novo: stdout/stderr já vão para **arquivos de log** em disco, com a linha em `background_processes` (SQLite, durável) apontando para eles. `bash_output` lê **direto dos logs**, independente do status — funciona em processo `running`, `exited` ou `killed`. Logo o output é recuperável **cross-turn** e **pós-compaction**, enquanto o modelo tiver o `process_id`.

Para o caso em que o modelo perde o `process_id` (turns depois, compaction), uma tool de listagem `bash_list` (`CONTRACTS.md §2.6.5d`) snapshota os bg da sessão (id, comando, status, exit code, spawn time, label) — o análogo de `task_list` para processos. Read-only.

Caveat herdado: logs muito grandes têm o head descartado (truncate-head); para um processo verboso o início pode se perder, sobra o tail. Não é regressão — é o cap de tamanho atual.

### 3B.3 Notificação na conclusão (canal de notifications)

Quando um processo settla (`exited`/`killed`/`failed`), o REPL empurra **um item num canal de NOTIFICATIONS in-memory — distinto do inbox**. O inbox carrega *intenção do operador* (input enfileirado durante um turn); o canal de notifications carrega *eventos de sistema* que devem alcançar o modelo. Separar os dois mantém responsabilidades distintas e habilita render próprio (§3B.7). O canal é **genérico, discriminado por `kind`**: `bg_done` é o primeiro produtor; a família `reminder` (§3B.9, `CONTRACTS.md §2.6.10`) é o segundo, adicionando o `kind: 'reminder'` sem alterar o canal — cada produtor traz sua própria lógica (o `BgManager` observa exits; o `ReminderScheduler` observa o relógio), o canal só armazena, formata e drena.

Shape do item `bg_done` (`CONTRACTS.md §2.6.5d`):

```
{ kind: 'bg_done', processId, command, status, exitCode }
```

- A detecção (`proc.exited`) já existe; o que muda é o **sink**: o evento ia pelo `onEvent` do turn que spawnou (que morre com o turn). Passa pelo canal **session-scoped** que o REPL detém (via o holder do `BgManager`, §3B.1) — vive entre turns.
- O output completo é recuperável via `bash_output` (`process_id` no item). Inline de um head-tail do output é refinamento, não normativo.
- O drain faz duas coisas: injeta as notificações como input do turn (§3B.4) **e** as ecoa no scrollback como linha de sistema (`● …`), distinta de uma barra de operador — o operador vê *por que* a sessão acordou.

### 3B.4 Wake-when-idle

Onde a notificação é processada depende do estado da sessão no settle:

- **Turn em curso** → o item fica no canal e drena no **próximo boundary** (o boundary drena o inbox primeiro — precedência do operador — e cai no canal de notifications quando o inbox está vazio). Sem wake.
- **Sessão `idle`** → **wake**: dispara um turn automático cujo input são as notificações drenadas. Transição em `STATE_MACHINE.md §2.2`: `[idle] --(bg_done ∧ guards)--> [running]`, gatilho `bg_done` (não `user_prompt`).

O auto-wake é o **comportamento default**, protegido por guardas medidas **antes** de disparar (premissa raiz — meça duas vezes); não há flag de gate (as guardas são a proteção):

| Guarda | Regra |
|---|---|
| **Coalescing** | o drain esvazia **todas** as notificações pendentes num único wake-turn. Sem timer de debounce: responsividade no caso comum (1 processo) > agrupar um burst espaçado raro, e o cap abaixo já limita a contagem de turns. Um micro-debounce (~100-200ms) é otimização opcional se o burst espaçado virar problema real. |
| **Budget gate** | wake só com budget remanescente (§8): `cumulative.costUsd ≥ maxCostUsd` → degrada para **semi-push** (notificação espera o próximo input). Nunca estoura cap para avisar. |
| **Operator-typing gate** | input buffer não-vazio no instante do drain → segura até submit/clear. Não rouba o turno do humano. |
| **Consecutive-wake cap** | no máximo `max_consecutive_wakes` (default 3) wake-turns sem input do operador entre eles. Atingido → para, aguarda o operador. Resetado em qualquer submit do operador. Backstop anti-loop (complementa §1.6). |
| **User-submit precedence** | o boundary drena o inbox antes do canal; um submit do operador reseta a cadeia de wakes. O operador sempre vence. |

### 3B.5 Concurrency & cancel

- Limites na matriz §11 (background processes default/cap já existem; o wake-turn herda os limites de turn normais).
- `bash_kill` reusa o cascade SIGTERM → 5s → SIGKILL.
- Cancellation (§7.1) inalterada: bg processes não recebem o AbortSignal do interrupt do turn — agora isso é consistente com sobreviverem ao turn (antes a inconsistência era: não recebiam o sinal, mas eram mortos pelo cleanup do finally mesmo assim).

### 3B.6 Comportamento default (sem flags)

- **Persistência + notificação + auto-wake são o comportamento default** — é o conserto do propósito da tool, não um opt-in. Não há flag de gate: o auto-wake é protegido pelas guardas de §3B.4 (typing, budget, cap, precedência do operador), que são a proteção real; um toggle adicional só seria duplicação.
- Um toggle de transição (reverter ao kill-at-turn-end antigo, ou forçar semi-push em vez de auto-wake) fica **deferido** — adicionável como flag se demanda real aparecer, mas não normativo. O backstop de `max_consecutive_wakes` cobre o medo principal (turns disparando sozinhos sem fim).

### 3B.7 UI

- Async em vôo aparece em **dois chips distintos** do footer (`UI.md §4.10.6`), por fonte: `N bash bg` (processos `bash_background`, `state.bgProcesses`) e `N subagents` (subagentes em vôo, `state.subagents`). Ambos verdes, suprimidos em 0.
- O **wake-turn** ecoa cada notificação drenada como uma **linha de sistema** no scrollback (`● <texto da notificação>`, tom secundário), distinta de uma barra de submit do operador — o operador vê *por que* a sessão acordou e sobre o que é o turn. (Um head-tail do output inline na notificação é refinamento.)

### 3B.8 Anti-patterns

| Anti-pattern | Por quê ruim |
|---|---|
| Tratar `bash_background` como within-turn (esperar que morra no fim do turn) | Agora persiste; um processo esquecido vive até o exit da sessão. Use `bash_kill` quando não precisar mais. |
| Auto-wake sem budget gate | Queima cap só para avisar; wake degrada para semi-push quando exausto (§3B.4). |
| Pollar `bash_output` em loop quando a notificação resolveria | A notificação na conclusão é o mecanismo push; o poll é para inspeção mid-run. |

**Eval acoplado:** `evals/bg/persistent_notify_wake/` — lança um bg de duração conhecida, fecha o turn, verifica que (a) o processo sobrevive ao boundary, (b) `bash_output` recupera o output depois, (c) a notificação aterrissa no inbox, (d) o wake dispara quando idle, (e) as guardas seguram (budget exausto → semi-push; burst → coalescing; cap de wakes para o loop).

### 3B.9 Produtor #2 — reminders (observa o relógio)

O canal de §3B.3 foi desenhado genérico; o `reminder` é o segundo produtor sem nenhuma mudança na mecânica de enqueue/drain/wake/guardas. ADR e reconciliação com o princípio guia ("meta-cognição não é tool") em `CONTRACTS.md §2.6.10`; catálogo em `CONTRACTS.md §2.6.5f`.

**O produtor.** Um `ReminderScheduler` **in-memory, session-scoped** — mesma natureza e ciclo de vida do `BgManager` (§3B.1) e do inbox: criado pelo REPL, morre no `cleanup()` do exit da sessão. **Não** precisa do padrão *holder* do `BgManager`: o scheduler não depende do `sessionId` (não escreve em SQLite — não há storage novo, §0/§13 preservados), então o REPL o constrói direto no boot e injeta em cada turn como o `todoStore`.

**Disponibilidade — só o REPL interativo.** A família `reminder` depende do scheduler + wake-when-idle, que **só** o REPL tem. Quando o scheduler é ausente, as tools são **escondidas do surface do modelo** (`buildToolDefs` filtra `requiresReminderScheduler` quando `config.reminderScheduler` é `undefined`, espelhando o gate de `requiresOperatorConfirm`) — não basta retornar tool-error, o modelo não deve ver uma tool que não pode usar. Dois contextos sem scheduler:

- **one-shot** (`run.ts`): sem próximo turn, um reminder nunca dispararia. Tools escondidas.
- **subagent**: sessão headless *run-to-completion*, sem estado idle para acordar. Tools escondidas do filho **e** barradas no `validate` (`requiresReminderScheduler` é o 4º check — um whitelist que liste reminder falha no bootstrap com mensagem clara). Distinto de `bash_background`, que um subagent *worktree* pode usar (roda dentro do próprio run do filho, sem precisar de wake).

**Disparo.** `reminder({ in, note })` agenda um `setTimeout(delay)`. Ao disparar, o scheduler empurra no canal:

```
{ kind: 'reminder', note, scheduledAt }
```

A partir daí é idêntico ao `bg_done`: **idle → wake** (dispara um turn cujo input é a `note`, como linha de sistema `● [reminder] <note>` no scrollback, §3B.7); **turn em curso → semi-push** (drena no próximo boundary). Todas as guardas de §3B.4 valem sem adição — typing-gate, budget-gate, consecutive-wake cap, precedência do operador. O input do wake-turn persiste com `source: 'system'` (migration 075), não como input do operador.

**Constraints normativas** (espelham `CONTRACTS.md §2.6.10`):

| Constraint | Regra |
|---|---|
| **Escopo** | in-memory, session-scoped. Sem persistência cross-session (§0). Reminder com horizonte > vida da sessão não dispara — aceito. |
| **Tempo** | só delay relativo (`in`); condicional é `wait_for` (retirado), não reintroduzir. |
| **Cap de horizonte** | default 24h. Obrigatório: `setTimeout` > 2³¹ ms dispara imediatamente — o cap fica bem abaixo. |
| **Cancel/list** | `reminder_cancel` faz `clearTimeout`+remove (idempotente); `reminder_list` snapshota os pendentes (recupera `reminder_id` perdido por compaction). |

**Transição.** O wake de §3B.4 agora dispara por `bg_done ∨ reminder_fired` (`STATE_MACHINE.md §2.2`).

**Eval acoplado:** `evals/reminders/` — agenda um reminder curto, fecha o turn, verifica (a) dispara no horizonte, (b) wake quando idle, (c) semi-push quando busy, (d) `reminder_cancel` desmarca antes do disparo, (e) `cleanup()` no exit não vaza timer pendente.

---

## 4. Compaction timing

### 4.1 Quando dispara

Trigger: tokens contados > **70%** do `context_window` do provider corrente.

Check **após cada step terminar**, **nunca no meio**:
- Step com tool em curso conclui antes
- Stream do modelo completa antes
- Validators (orchestrated) terminam antes
- DAG: check após **subgraph** terminar, não nodo individual

### 4.2 Sequência

```
Step N termina → idle
  ↓
context_token_count check
  ↓
if count > 70% × context_window:
    suspend step loop
    ↓
    [PreCompact hook] — BLOCKING (pode cancelar)
    ↓
    if cancelled: continue with truncation fallback
                  (cut tool results > 1KB com pointer)
    ↓
    Compaction LLM call (modelo configurável; default cheap)
    ↓
    Validate compaction output (schema check)
    ↓
    if invalid: retry once
    if invalid 2x OR budget exceeded: deterministic fallback (§4.6)
    ↓
    Atomic swap: turns >3 antigos ⇒ summary
    Goal re-injection literal + pinned context (CONTEXT_TUNING.md §12.4)
    ↓
    Resume step loop (próximo step usa contexto compactado)
```

### 4.3 Atomicidade

Compaction é **transação**:
- Old context preservado em SQLite até commit
- Falha mid-compaction: rollback pra old context (próximo step usa contexto não-compactado, com warning)
- Sucesso: turns marcados `compacted=true`; summary persisted

**Não há "estado intermediário" visível.** Compaction é all-or-nothing.

### 4.4 Compaction em DAG (orchestrated)

DAG node tem context próprio (mais isolado que session step). Compaction não dispara mid-DAG por default.

Se DAG é longo (50+ nodes) e context global cresce:
- Trigger: após cada **subgraph terminar** (não nodo individual)
- Mesma sequência

### 4.5 Modelo da compaction

Default por profile:
- `autonomous` Anthropic: Haiku
- `autonomous` OpenAI: gpt-4o-mini
- `autonomous` outro vendor: cheap model do mesmo provider
- `orchestrated`: backend local (mesmo modelo do executor)
- `hybrid`: planner model (default Haiku)

Override via `compaction.model` em config (ver `AGENTIC_CLI.md` §6 Compaction).

### 4.6 Fallback determinístico

> **Cross-refs:** pinned context em `CONTEXT_TUNING.md §12.4`; selective elision em `CONTEXT_TUNING.md §12.1-12.2`; failure mode `compaction.llm.unavailable` em `FAILURE_MODES.md`.

Compaction-via-LLM (§4.5) é o caminho default, mas tem três modos de falha que **não devem** levar a `error_fatal`:

1. **LLM falha 2× consecutivas** (§4.2 step "if invalid 2x") — provider indisponível, schema violation persistente, rate limit duro.
2. **Budget excedido** — `compaction.max_cost_usd` ou `compaction.max_duration_ms` estouraram (defaults: $0.05, 30s).
3. **PreCompact hook cancelou** (§4.2 step "if cancelled") — caminho já existente, agora unificado aqui.

Em qualquer um dos três, harness aplica fallback estático **sem LLM**:

```
Eviction policy (deterministic):
  1. Identify pinned items (CONTEXT_TUNING.md §12.4) — always preserved.
  2. Preserve last K turns literally (default K=3, configurable).
  3. Preserve goal + sub-goals literal (CONTEXT_TUNING.md §10).
  4. Drop tool_results from turns older than K, EXCEPT:
       - tool_results referenced em decisions[] (RECAP.md §3) — keep
       - tool_results com writes:true que não foram revertidos — keep metadata, drop body
       - pinned tool_results — keep
  5. Replace dropped tool_results com pointer:
       <tool_result tool="..." step="..." elided="size_bytes" reason="static_fallback">
  6. If still > 70% após drop: truncate oldest assistant turns head+tail
     (preserve first 200 chars + last 200 chars; insert "... N tokens elided ...").
  7. Re-inject goal + pinned context.
```

**Garantias:**

- **Idempotente.** Mesmo input ⇒ mesmo output. Sem LLM ⇒ sem variabilidade.
- **Bounded.** Custo zero (USD), latência < 50ms (puro SQL + string ops).
- **Audited.** Cada drop registrado em `sessions.elided_tool_results_count` (`CONTEXT_TUNING.md §12.2`); `failure_event` `compaction.fallback.used` com motivo (`llm_failed` | `budget_exceeded` | `hook_cancelled`).
- **Observável.** UI mostra warning `⚠ compaction degraded: static fallback (reason)` no próximo turno; `/recap` inclui o evento.

**O que se perde:** sumarização semântica de turns antigos. Modelo vê pointer em vez de "N rodadas de exploração resumidas em 2 frases". Trade-off explícito: **degradação visível > erro fatal**. Sessão continua; user pode `/clear` e recomeçar se quiser contexto limpo.

**Quando NÃO cair em fallback:**

- LLM falhou **1×** apenas: retry uma vez antes (já coberto em §4.2).
- Provider down mas backup provider configurado: tenta backup antes do fallback (`PROVIDERS.md` cobre fallback chain).
- `PreCompact` hook retornou com `hard_cancel: true` (`§5.1.1`): respeita decisão do user, não força fallback — vai pra `error_fatal` (raro; opt-in explícito).

**Eval acoplado:** `evals/compaction/static_fallback/` — fixture com provider mockado retornando lixo; verifica que sessão não quebra, contexto post-compaction satisfaz invariante de tokens, e modelo seguinte consegue completar tarefa simples (read-modify-write).

---

## 5. Hook chain composition

### 5.1 Bloqueáveis vs não-bloqueáveis

Tabela canônica:

| Evento | Bloqueia loop? | Block ação? | Schema do payload |
|---|---|---|---|
| `SessionStart` | sim | não | `{ session_id, cwd, profile }` |
| `UserPromptSubmit` | sim | sim (rejeita prompt) | `{ session_id, prompt }` |
| `PreToolUse` | sim | sim (nega tool) | `{ session_id, tool_name, args }` |
| `PostToolUse` | **não — fire-and-forget** | não | `{ session_id, tool_name, args, output, duration_ms }` |
| `PreCompact` | sim | sim (cancela compaction) | `{ session_id, current_tokens, threshold }` |
| `Notification` | não — fire-and-forget | não | `{ session_id, kind, message }` |
| `PreCheckpoint` | sim | não | `{ session_id, files_to_snapshot }` |
| `MemoryWrite` | sim | sim (bloqueia write) | `{ session_id, scope, name, body, source }` |
| `Stop` | sim (final) | não | `{ session_id, status, total_cost_usd }` |

### 5.1.1 Payload de retorno (hooks bloqueáveis)

Hook bloqueável retorna JSON com formato:

```json
{
  "decision": "allow" | "block",
  "reason": "<string opcional>",
  "hard_cancel": true | false        // opt-in; ver abaixo
}
```

**`hard_cancel: true`** (opt-in, default `false`) altera o tratamento do bloqueio em hooks específicos:

- **`PreCompact`** com `hard_cancel: true` → compaction não cai em fallback determinístico (`§4.6`); transita pra `error_fatal*`. Sem `hard_cancel`, bloqueio cai em fallback (sessão prossegue degradada).
- **Outros hooks bloqueáveis:** `hard_cancel` ignorado (sem semântica especial); decisão `block` sempre cancela a operação corrente sem matar a sessão.

Razão: default é **fail-soft** (degradar > parar). User que precisa de fail-stop em compaction (ex: política regulatória que proíbe contexto incompleto) ativa `hard_cancel` explicitamente.

### 5.2 Ordem de execução

Pra mesmo evento com N hooks, ordem hierárquica:

1. **Enterprise hooks** (em ordem de declaração)
2. **User hooks**
3. **Project hooks**

**Sequencial dentro do mesmo nível.** Primeiro hook que retorna `block` em evento bloqueável **interrompe a chain**.

### 5.3 Timeouts

| Limite | Default | Configurável até |
|---|---|---|
| Por hook | 5s | 30s |
| Chain total | 15s | 30s (`max_hook_chain_ms`) |

Se chain hit total: hooks remanescentes não rodam; warning loggado em `hook_runs`.

Em evento bloqueável: assume `allow` se chain não terminou (a menos `fail_closed: true` no hook).

### 5.4 Fire-and-forget para não-bloqueáveis

`PostToolUse`, `Notification`:
- **Não bloqueiam** loop principal
- Loop principal **inicia próximo step imediato**
- Hook roda em background; output ignorado pelo loop
- Falha do hook não afeta loop (audit em `hook_runs`)
- Hook órfão (timeout extrapolado): SIGTERM em background; loop não espera

### 5.5 Hooks paralelos (NÃO suportado em v1)

Hooks **sempre sequenciais**. Paralelismo entre hooks = race condition em side effects (auto-format conflitando com lint, etc).

V2 pode adicionar `parallel: true` flag opt-in com responsabilidade do user.

---

## 6. Self-critique placement

### 6.1 Quando roda

`critique.mode` determina:

| Mode | Quando |
|---|---|
| `off` (default) | nunca |
| `on_writes` | step com tool_use de `writes: true` propõe **antes do invoke**; step que termina sem tool_use **antes do persist** |
| `always` | toda step LLM (excluí read-only tool steps como `read_file`/`grep`) |

### 6.2 Sequência

```
Step N: provider call retorna output
  ↓
Parse output → buffer (NÃO persist ainda)
  ↓
if critique.mode applicable to this step:
    Critic LLM call (input: step input + output buffer)
      ↓
    Parse critique → structured issues (schema fixo)
      ↓
    Filter por threshold (default 0.7)
      ↓
    if issues filtered:
        Emit `critique:ask` (modal pattern, UI.md §5.5)
        User: ignore | redo | abort
          ↓
        if ignore: persist buffer → context (registra `critique.warning_ignored`)
        if redo: discard buffer; re-run step com hint do critic injetado
        if abort: discard buffer; step → error_user_aborted
    else:
        persist buffer → context
  ↓
Step done
```

### 6.3 Custo & telemetry

- Critique cost: span próprio em traces (`critique.cost_usd`, `critique.duration_ms`)
- **Não somado** ao cost do step principal
- Aparece em `/cost` breakdown como linha separada

### 6.4 Critique não recursivo

Critic LLM **não tem critique próprio** (loop infinito). É plain LLM call, sem self-critique encadeado.

### 6.5 Critique para tool_use

Para `on_writes` em tool com `writes: true`:
- Critique do **plano de invocação** (args do tool antes de invoke)
- Não do tool result (que já tem permission engine)
- Se critic detecta plano ruim: bloqueia invoke; user decide redo/abort

Para `always` em tool read-only:
- Critique do output completo do step (texto + tool_use propostos)

### 6.6 Trade-offs em hybrid

Em profile hybrid:
- `critique.model` pode ser local (qwen) mesmo com executor frontier
- Ou inverso: critique frontier mesmo com executor local
- Casos de uso:
  - Local executor + frontier critique = "second opinion" pra catches
  - Frontier executor + local critique = double-check barato

---

## 7. Cancellation cascading

### 7.1 AbortSignal paralelo

User Ctrl+C → `interrupt_signal` propagado simultaneamente para:

- Tool em curso (HTTP abort, signal handler)
- Hook em curso (SIGTERM)
- Subagents (SIGTERM via process tree)
- LLM stream (HTTP abort do request)
- DAG executor (cascade pra todos os nodes)
- Critique LLM call (HTTP abort)

**NÃO recebe** AbortSignal:
- Background processes (`bash_background`) — preservados via heartbeat; ver §3 PERFORMANCE
- Compaction em curso (atomic; trata como graceful complete; aborta na próxima vez)
- Checkpoint snapshot em curso (atomicidade FS)
- SQLite transaction commit (atomicidade DB)

### 7.2 Wall-clock budget

```
T+0:    interrupt_signal disparado paralelo
T+5s:   graceful deadline — tudo deve terminar
T+6s:   SIGKILL — forced kill em processos sobreviventes
T+6s:   sessão entra em `idle` ou `done`
```

Total ≤ 6s pra `interrupt_complete`.

Subsistemas que sobrevivem após SIGKILL: marcados como zombie em `failure_events.zombie_process`; sessão prossegue (não bloqueia).

### 7.3 Estado após interrupt

- Step em curso, **não persistido**: descartado
- Step com tool_calls **persistidos** (mesmo se tool não terminou): marcado `interrupted` em `tool_calls.status`
- Subagent: output sintético `{ status: 'interrupted' }`
- DAG: nodes em `executing` marcados `interrupted`; `done` preservados

Próxima ação: aguarda input do user (`idle`) ou exit (`done`).

### 7.4 Double Ctrl+C

- 1× Ctrl+C: `interrupt_signal` (graceful)
- 2× Ctrl+C dentro de 1s: força SIGKILL imediato (skip 5s graceful)
- 3× Ctrl+C: exit do processo do agente (mata tudo, incluindo background processes)

Audit registra cada nível.

### 7.5 Stream interrupt UX (mid-token)

User interrompe **enquanto modelo está streamando tokens**:

| Atalho | Estado loop | Ação |
|---|---|---|
| `Esc Esc` | streaming | interrompe stream; **tokens parciais permanecem na tela** com label `[interrupted at token N]`; input editável com prompt original carregado; loop volta a `idle` |
| `Esc Esc` | tool_exec | interrompe tool (graceful 5s + SIGKILL); tool_result sintético `{ status: 'interrupted' }`; volta a `idle` |
| `Esc Esc` | compacting | **ignorado** (compaction é atomic, ≤ 3s; aguarda terminar) |
| `Ctrl+C` 1× | streaming | full interrupt cascading (§7.1); tokens parciais somem da tela; cost dos parciais registrado em `failed_attempts.cost_usd` |
| `Ctrl+C` 1× | tool_exec | mostra prompt "tool em execução; press de novo pra forçar"; 5s timeout volta ao normal |
| `Ctrl+C` 2× rápido | qualquer | force SIGKILL imediato |
| `Ctrl+C` 3× | qualquer | exit do agent |

**Diferença chave Esc Esc vs Ctrl+C em streaming:**
- `Esc Esc` é **suave** — pra "ah, quero re-prompt diferente"; texto visível preservado pra contexto humano
- `Ctrl+C` é **cancel total** — pra "para tudo"; tela limpa do step incompleto

Em ambos: **tokens parciais NÃO vão pra `messages`** (rollback de step transaction). Cost de tokens emitidos é cobrado pelo provider e registrado separado.

---

## 8. Budget cascading

### 8.1 Hierarquia

```
Session budget (max_cost_usd, max_steps, max_wall_clock_ms)
  └─ shared com:
       Subagent budget (≤ session, sem pre-alocação)
       DAG execution budget (≤ session)
       Compaction call budget (≤ session)
       Critique call budget (≤ session)
       Provider call budget (per-call timeout, retry budget)
```

Tudo compete pelo budget remanescente.

### 8.2 Hit do limite

| Limite | Comportamento |
|---|---|
| Hard cap (`max_cost_usd`) | step ativo recebe sinal de finalizar; novos spawns rejeitados; sessão eventualmente marca `exhausted` |
| Soft warning (90%) | UI alerta; user pode `/budget extend $N` |
| `max_steps` hit | sessão imediatamente `exhausted` no fim do step atual |
| `max_wall_clock_ms` hit | `interrupt_signal` paralelo; cleanup |

### 8.3 Subagent vs pai

- Subagent hit antes do pai: subagent termina com `status: exhausted`; pai continua com output parcial
- Pai hit antes de subagent: pai sinaliza subagent pra terminar; aguarda graceful

### 8.4 Allocation hints

User pode hintar (não enforce):

```bash
agent --max-cost 5 --subagent-budget-hint 1.5 "..."
```

Hint usado pelo planner pra:
- Pre-rejeitar `task_async` que provavelmente excede o hint
- UI mostrar "subagent excedeu hint mas continua dentro do budget global"

Pode ser ignorado pelo modelo se uso real divergir.

---

## 9. Subgraph expansion model

### 9.1 Inline expansion

Subgraph node é **expandido em load time** do DAG:

```yaml
# DAG principal
nodes:
  - id: prep
    type: deterministic
    fn: load_baseline
  - id: refactor
    type: subgraph
    ref: edit_function       # nome do DAG referenciado
    inputs_from: [prep]
```

```yaml
# Subgraph edit_function (em outro arquivo)
nodes:
  - id: locate
    type: llm
    inputs: external          # vem de inputs_from do parent
  - id: apply
    type: tool
    inputs_from: [locate]
```

Em load:
```
[prep] → [edit_function.locate] → [edit_function.apply]
```

Mesma execução, mesmo processo, mesmo session.

### 9.2 Inputs/outputs

- `inputs_from: [prep]` no subgraph node = passado como input do **first node(s)** do subgraph (declarado com `inputs: external`)
- Output do **last node** do subgraph = output do subgraph node

Validation em load: se subgraph não tem first node com `inputs: external` ou last node com schema declarado, falha.

### 9.3 Cancelamento e budget

- AbortSignal cascateia pra todos nodes expandidos
- Budget herda do DAG pai (não tem budget próprio)
- Falhas reportam path completo: `parent.refactor.locate (validation_failed)`

### 9.4 Quando NÃO usar subgraph

Use `task_async()`/subagent quando:
- Quer **isolation real** (worktree dedicado)
- Quer **budget próprio** que não afete pai
- Subgraph **muito longo** (40+ nodes) poluiria histórico/audit do pai

Subgraph é **inline + cheap** (sem isolation overhead). Subagent é **isolado + caro** (processo separado, contexto novo).

---

## 10. Hybrid routing grammar (v1)

### 10.1 Lista de regras simples

Cada regra: **uma condição, uma ação**.

```toml
[[profile.hybrid.rule]]
when = { validator_failures_consecutive_gte = 2 }
then = "fallback_to_frontier"

[[profile.hybrid.rule]]
when = { node_type = "refactor" }
then = "use_executor_local"

[[profile.hybrid.rule]]
when = { step_cost_estimate_gt_usd = 0.10 }
then = "ask_user"

[[profile.hybrid.rule]]
when = { context_tokens_gt = 30000 }
then = "use_executor_frontier"      # context grande precisa janela larga

# Catch-all default (recomendado)
[[profile.hybrid.rule]]
when = "always"
then = "use_executor_local"
```

### 10.2 Conditions suportadas (v1)

| Condition | Tipo |
|---|---|
| `validator_failures_consecutive_gte` | int |
| `node_type` | string |
| `tool_name` | string |
| `step_cost_estimate_gt_usd` | float |
| `context_tokens_gt` | int |
| `model_capability_required` | string (`vision` \| `extended_cache` \| `tools_native`) |
| `always` | (catch-all) |

### 10.3 Actions suportadas (v1)

| Action | Comportamento |
|---|---|
| `use_executor_local` | step roda em local model |
| `use_executor_frontier` | step roda em frontier model |
| `fallback_to_frontier` | escala atual pra próximo tier |
| `ask_user` | apresenta modal de escolha |
| `abort_step` | marca step como falha sem tentar |

### 10.4 Precedência

Regras avaliadas em **ordem de declaração**. Primeira que match aplica. Sem AND/OR/NOT em v1.

**Catch-all sempre recomendado** como última regra (evita comportamento undefined).

### 10.5 v2 — DSL composta (deferred)

Quando demanda real chegar:
- Operadores (AND, OR, NOT)
- Nested conditions
- Aliasing de regras
- Validation em config-load

Por enquanto: enxuto e suficiente.

---

## 11. Concurrency limits matrix

Resumo dos limites operacionais:

| Recurso | Default | Hard cap | Configurável? |
|---|---|---|---|
| Sessões ativas (mesmo cwd) | 1 | 1 (lockfile) | não |
| Subagents paralelos por sessão | 3 | 8 | sim (`max_concurrent_subagents`) |
| Tool calls em flight (DAG) | 5 | 16 | sim (`max_concurrent_tool_calls`) |
| LLM calls concorrentes (DAG) | 5 | 16 | sim (`max_concurrent_llm_calls`) |
| Background processes | 5 | 20 | sim |
| Hooks paralelos por evento | 1 | 1 (sequencial) | não em v1 |
| MCP server connections | 10 | 30 | sim |
| Validators sequential per node | 5 | 20 | sim |
| Critique calls em flight | 1 | 1 (sequencial) | não |
| Compaction calls em flight | 1 | 1 (atomic) | não |
| `wait_for` em flight (per session) | 3 | 8 | sim |
| `monitor` em flight (per session) | 2 | 5 | sim |

---

## 12. Anti-patterns

| Anti-pattern | Por quê ruim |
|---|---|
| Compaction mid-step | Quebra atomicidade; tool result órfão |
| `task_sync` em sequência pra tarefas paralelizáveis | Latência cumulativa; use `task_async` |
| `task_async` sem `task_await` correspondente | Subagent zombie; budget queimado sem benefício |
| Hook não-bloqueável bloqueando loop | Quebra contrato; bug |
| Critique recursivo (critique do critique) | Loop infinito; proibido |
| Subgraph com isolation real | Use `task_async`; subgraph é inline |
| Cancellation sequencial | Wall-clock acumula; user fica esperando |
| Budget pre-alocado entre subagents | Desperdiça reservatório; competição shared é eficiente |
| Hybrid routing sem catch-all default | Comportamento undefined em edge cases |
| Compaction LLM com mesmo modelo do step principal | Custo desnecessário; use cheap model |
| Hooks paralelos com side effects sobrepostos | Race condition; format vs lint conflict |
| DAG sem `max_concurrent` declarado | Implementação default pode divergir |
| `PostToolUse` que bloqueia (espera response) | Quebra fire-and-forget; trava loop |

---

## 13. Insight final

Orquestração não é "qual ordem o agente faz coisa". É **contrato de timing entre subsistemas** que precisa ser explícito pra implementadores não divergirem.

Spec arquitetural (`AGENTIC_CLI.md`, `CONTRACTS.md`, `STATE_MACHINE.md`) diz **o quê** e **com que invariantes**. Este doc diz **quando, em que ordem, com que paralelismo, com que cancellation**.

A regra é: **toda decisão de timing tomada uma vez aqui, replicada perfeita em todo lugar.** Sem timing implícito. Sem "fica a gosto da implementação". Sem ambiguidade que vira bug em prod.

E como tudo no projeto: **meça duas vezes, corte uma.** Validators medem antes de corte. Hooks medem antes/depois de corte. Compaction mede contexto antes de cortar (resumir). Critique mede output antes de comprometê-lo ao contexto. Cada decisão de timing aqui é instância dessa premissa aplicada à coordenação.
