# IPC

Canal vivo entre processo pai e processo filho (subagent) para o `AGENTIC_CLI`. Hoje subagents rodam como subprocess com comunicação one-shot: pai spawn → filho roda em isolamento → escreve payload terminal no SQLite → exit. Este doc define o protocolo bidirecional que substitui o silêncio do subprocess por uma stream observável e controlável.

> Subagent sem IPC é caixa-preta: operador stareia o TUI por 5 minutos, nenhum sinal de progresso, Esc não responde. Spec §11 desenhou subagents como unidades paralelas de trabalho — sem IPC eles são glorified subprocess invocations.

---

## 0. Princípios (não-negociáveis)

1. **Stream-shaped, não request-response.** Filho envia eventos conforme acontecem. Pai envia comandos quando precisa. Sem polling, sem ack obrigatório por mensagem.
2. **Line-framed, JSON-encoded.** NDJSON na stream. Uma linha = uma mensagem. Debugável com `tail`, `jq`, qualquer ferramenta de log.
3. **Stdin/stdout do filho são reservados ao protocolo.** Filho NÃO escreve nada no stdout fora do canal. Diagnóstico vai pro stderr (ou audit log no SQLite).
4. **Falha do canal não é falha do filho.** Quebra de pipe (pai morreu, EOF inesperado) → filho pode continuar (ou não, decisão por slice). Falha do filho (process exit) → pai detecta via `proc.exited`, independe do canal.
5. **Backwards-compatible com subprocess existente.** O canal é opt-in via flag de spawn (`--ipc`). Filho sem flag mantém comportamento atual (one-shot via SQLite). Tests + scripts que rodam fora do REPL continuam funcionando sem mudança.
6. **Eventos são best-effort, não authoritative.** O SQLite continua sendo a source of truth para estado persistido (`subagent_outputs`, `subagent_runs`). IPC entrega visibilidade live; perda de eventos não corrompe estado — apenas degrada UX (tray "atrasado").
7. **Sem cargo cult de RPC framework.** Sem gRPC, sem Cap'n Proto, sem custom transport. Stdin/stdout são primitivos do Bun.spawn; NDJSON é text. Total: zero dependências novas.

---

## 1. Escopo

### 1.1 O que IPC habilita

- **Subagent observability** (TUI Subagent group): pai recebe `step_start`, `tool_invoking`, `tool_finished`, `assistant:start/delta/end`, `usage`, `step:budget` do filho enquanto ele roda. Renderiza chips agrupados por subagentId.
- **Soft-stop propagation** (D159): Esc no pai → pai envia `interrupt:soft` no canal → harness do filho recebe via `softStopSignal` injetado e exita no próximo step boundary. Sem matar mid-tool.
- **abortCause genuíno em subagents** (D168): com soft-stop real, `RunSubagentResult.abortCause` ganha o discriminador `'soft' | 'hard'` que hoje seria sempre `'hard'`.
- **Permission proxy** (futuro, fora do M1): filho que precisa de aprovação user-facing pode pedir ao pai via canal em vez de falhar. Pai abre o modal no operator's TUI; resposta volta pelo canal.

### 1.2 O que IPC NÃO faz

- **Não substitui SQLite.** `subagent_outputs` permanece sendo o lugar canônico do payload final. IPC é stream live; SQLite é state persistido.
- **Não cria multi-master.** Pai é o único que envia comandos. Filho é o único que envia eventos. Bidirecional, mas com papéis fixos por sentido.
- **Não atravessa machine boundaries.** Apenas processo pai/filho na mesma máquina. Distributed agents é outra spec.
- **Não substitui MCP.** MCP é um protocolo entre Forja e tools externas (servers); IPC é interno ao Forja entre seus próprios processos.

---

## 2. Transport

### 2.1 Escolha: stdin/stdout NDJSON

| Opção avaliada | Por que rejeitada |
|---|---|
| Unix domain socket | Setup extra, POSIX-only, atravessa filesystem |
| gRPC / Cap'n Proto | Dependência externa pesada para um canal de processos vizinhos |
| Shared SQLite events table | Polling latency; já tentamos parcial via `subagent_outputs` e UX é ruim |
| Named pipe / FIFO | POSIX-only, quirks por OS |
| **Stdin/stdout NDJSON** | **Primitivo do Bun.spawn, zero deps, testável com `cat`/`jq`** |

### 2.2 Detalhes

- **Pai → filho**: pai escreve linhas no `child.stdin`. Cada linha é JSON terminado por `\n`. Sem length prefix.
- **Filho → pai**: filho escreve linhas no `process.stdout`. Mesmo formato.
- **Filho herda stderr** do pai (ou redireciona pra log file via flag de spawn). Diagnóstico humano (warnings, traces) vai aqui — fora do canal.
- **Encoding**: UTF-8. Mensagens com caracteres binários devem base64-encodar campos relevantes.
- **Limite por mensagem**: 1 MB. Acima disso, fragmentar em chunks ou referenciar via SQLite. (Streams de tool output longos já são truncados upstream pelo `appendPreview` — não chegam aqui inteiros.)
- **EOF**: fechar stdin do filho = "encerrar canal de comandos". Filho continua rodando até completar ou ser killed via OS signal. Filho fechando stdout = "encerrar canal de eventos" (raro; sinal de problema).

### 2.3 Backpressure

- **Filho → pai**: stdout tem buffer do OS. Se pai parar de ler, filho bloqueia em write. Pai DEVE consumir `child.stdout` continuamente (nunca aplicar pause).
- **Pai → filho**: stdin do filho é não-bloqueante na maioria dos casos. Comandos são raros (interrupt soft/hard, permission answer); volume é trivial.

---

## 3. Message taxonomy

Todas as mensagens têm shape:

```json
{ "type": "<kind>", "id": "<uuid>", "ts": <epoch_ms>, ...payload }
```

`id` é UUID v4 — útil para correlacionar request/response (permission proxy) e debug. `ts` é wall-clock do emissor.

### 3.1 Pai → filho (commands)

| `type` | Payload | Semântica |
|---|---|---|
| `interrupt:soft` | `{}` | Operador pediu soft stop. Filho aborta `softStopSignal` interno; harness sai no próximo step boundary. Idempotente — múltiplos `interrupt:soft` são no-op após o primeiro. |
| `interrupt:hard` | `{}` | Operador escalou. Filho aborta `signal` (hard); preempta in-flight work. Equivalente semântico ao SIGTERM mas sem race do OS signal vs canal. |
| `permission:answer` | `{ promptId, decision }` | Resposta a uma `permission:ask` que o filho mandou. (Slice futuro; não M1.) |
| `shutdown` | `{}` | Pai está exitando, filho deve encerrar limpo agora. Fast-path do `interrupt:hard` + EOF no stdin. |

### 3.2 Filho → pai (events)

Espelho dos `HarnessEvent` que o harness do filho já emite via `config.onEvent`. O canal IPC é apenas o transporte; a taxonomia é a mesma de `src/harness/types.ts`.

| `type` | Payload (resumido) | Quando |
|---|---|---|
| `session_start` | `{ sessionId }` | Filho começou. |
| `step_start` | `{ stepN }` | Cada iteração do loop. |
| `provider_event` | `{ event: StreamEvent }` | Cada evento da stream do provider (start, delta, usage, stop). |
| `tool_invoking` / `tool_decided` / `tool_finished` | (idem HarnessEvent) | Lifecycle de tool. |
| `bg_started` / `bg_ended` | (idem HarnessEvent) | Bg processes spawned pelo filho. |
| `todo_updated` | `{ items }` | Filho mexeu na própria TodoList. |
| `permission:ask` | `{ promptId, toolName, command, cwd }` | (Slice futuro; não M1.) Filho pede aprovação. |
| `session_finished` | `{ result: HarnessResult }` | Filho terminou. Última mensagem antes do EOF. |

### 3.3 Eventos que NÃO atravessam IPC

- **Eventos puramente locais ao filho** (debug logs, internal traces): vão pro stderr ou pro próprio audit do filho.
- **Estado persistido** (mensagens, audit rows, checkpoints): já vão pro SQLite. Pai consulta lá quando precisa do canônico (resume, replay).
- **`session:end` UIEvent**: o pai não tem TUI próprio para o filho — ele compõe o subagent group no SEU próprio TUI usando os HarnessEvents recebidos.

---

## 4. Lifecycle

### 4.1 Spawn

1. Pai chama `runSubagent({ ... ipc: true })`.
2. Pai monta `Bun.spawn` com `stdin: 'pipe', stdout: 'pipe', stderr: 'inherit'`.
3. Pai passa flag `--ipc` no argv do filho. Sem essa flag, o subagent runtime do filho NÃO inicia o canal (compat com one-shot mode).
4. Filho detecta a flag, instala um listener em `process.stdin` (line-buffered) e configura `process.stdout.write` para serializar HarnessEvents → NDJSON.

### 4.2 Handshake

- **Sem handshake explícito.** A primeira mensagem do filho é `session_start`. A primeira mensagem do pai pode ser nada (consume-only) ou um `interrupt:*` se o operador apertou Esc imediatamente.
- **Versionamento**: o argv flag carrega versão (`--ipc=1`). Filho que não conhece a versão sai com error code `IPC_VERSION_MISMATCH` antes de qualquer mensagem.

### 4.3 Encerramento normal

1. Filho emite `session_finished`.
2. Filho fecha stdout naturalmente (process exit).
3. Pai detecta EOF + `proc.exited`.
4. Pai persiste payload final no SQLite (já existe — `publishSubagentOutput`).

### 4.4 Encerramento por interrupt

- **Soft**: pai envia `interrupt:soft`; aguarda `session_finished` com `abortCause: 'soft'`. Se passar `gracePeriodMs` sem resposta, escala pra hard.
- **Hard**: pai envia `interrupt:hard`; aguarda `session_finished`. Se passar `gracePeriodMs`, OS signal (SIGTERM → SIGKILL) toma o lugar.

### 4.5 Falha do canal

- **Pipe broken (filho morreu sem `session_finished`)**: pai sintetiza um `RunSubagentResult` com `reason: 'subprocess_crashed'`. SQLite ainda pode ter parciais via `subagent_outputs`.
- **JSON malformado do filho**: pai loga warning, descarta a linha. Não derruba o canal — uma linha ruim não invalida a próxima.
- **Pai morreu (filho órfão)**: filho recebe SIGHUP/EOF no stdin; encerra via path normal.

---

## 5. Backwards compatibility

- **Subagent runtime existente continua funcionando sem `--ipc`.** Os tests em `tests/subagents/` não passam a flag; nada quebra.
- **`spawnChildProcess` test seam** (em `runtime.ts`) recebe um adapter para o canal: testes podem injetar um fake transport (in-memory queue) em vez de subprocess real. Mantém a property "harness in-process pra tests, subprocess pra produção".
- **A flag `--ipc` é independente de outras flags** (`--subagent-session-id`, etc). Pode coexistir.

---

## 6. Performance

- **Latência fim-a-fim típica**: < 5ms por mensagem (escrita stdin + flush + read stdout). Bound pelo OS buffer flush.
- **Overhead por step do filho**: ~5 mensagens (step_start + 1-2 provider_events + tool lifecycle). < 25ms total — invisível comparado ao step do LLM (centenas de ms a segundos).
- **Volume típico de uma sessão**: 100-500 mensagens. Negligível.
- **Memória**: pai mantém um buffer pequeno (ring buffer dos últimos N eventos por subagentId, para o TUI render). Cap em 200 eventos por subagent — além disso descarta os mais antigos.

---

## 7. Trust boundary

- **Filho roda com mesmo trust level que o pai** (mesmo cwd, mesma policy, mesmo signal). IPC não relaxa nada.
- **Mensagens do filho NÃO são confiáveis em sentido de input-do-usuário** — são geradas pelo modelo dentro do filho. O pai não deve, por exemplo, executar conteúdo de uma mensagem `tool_invoking.args` como código no seu próprio contexto.
- **`permission:ask` do filho exige same modal flow do pai**: o operator vê e aprova; resposta volta para o filho. O filho NUNCA recebe um auto-approve via IPC; o canal só transporta a decisão do humano.

---

## 8. Anti-patterns

- **Não usar IPC pra heartbeat/keep-alive.** Filho vivo é detectado por `proc.exited` (OS-level). Heartbeat por canal é cargo cult.
- **Não broadcast.** IPC é estritamente 1:1 (um pai, um filho). Multi-cast = pool/registry no pai, cada conexão ainda 1:1.
- **Não usar IPC pra dados grandes.** Tool output > 1MB vai pro SQLite (já vai); IPC só carrega a notificação de "tool ended". Pai consulta SQLite quando precisa do conteúdo.
- **Não codificar binário inline.** Base64 quando inevitável; preferir referenciar arquivo via path.
- **Não introduzir RPC com return value.** O canal é stream de eventos + comandos one-way. Request/response casa só pra `permission:ask` (cuja "response" é um event distinto). Generalizar pra RPC = fight com a semântica natural de stream.

---

## 9. Migration path

1. **Slice 1**: transport + framing (stdin/stdout NDJSON, no semantics yet). Pai cria canal, filho ecoa eventos. Tests com fake transport.
2. **Slice 2**: HarnessEvent → IPC message serialization no filho; deserialização + onEvent forward no pai. Subagent observability landing (1.f.2).
3. **Slice 3**: `interrupt:soft`/`interrupt:hard` propagation. Soft-stop em subagents (D159). `abortCause` em subagent results (D168).
4. **Slice 4** (futuro, M2+): `permission:ask` proxy.

Cada slice é landable independentemente. 1+2 já entrega 80% do valor (operator finalmente vê e cancela subagents).

---

## 10. Open questions (a resolver antes do slice 1)

1. **Quem owns o pump loop do canal?** O pai já tem um event loop (REPL). Adicionar um `for await (const line of child.stdout)` por subagent ativo. Ordem de processamento: FIFO por subagent, mas inter-subagent é arbitrária (cada um tem o próprio bus subscriber).
2. **Buffering antes do TUI ter um Subagent group renderer.** Slice 1 entrega o canal mas TUI ainda não renderiza — o que fazer com os eventos? Opções: (a) descartar (fácil, perde slice 1 standalone), (b) bufferizar e descartar com cap (pequeno overhead), (c) gravar no audit (já existe via SQLite, redundante). Recomendação: (b) com cap baixo até slice 2.
3. **Schema migration**: o argv flag versiona o protocolo. Mas precisamos de um teste de regressão que prove que pai vN consegue conversar com filho vN-1 (ou explicitamente recusar). Definir matrix de compat antes do slice 1.
