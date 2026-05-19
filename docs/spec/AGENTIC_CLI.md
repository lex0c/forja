# AGENTIC_CLI

Projeto de uma CLI agentic open-source. **Terminal-first**, multi-provider, self-hostable, sem vendor lock-in.

Não é wrapper de API. Não é chatbot com `bash`. É um agente real, com loop controlado, tools auditáveis, contexto engenheirado e observabilidade nativa.

---

## 0. Visão

> **Meça duas vezes, corte uma.**

Essa é a premissa raiz da qual o resto do projeto deriva. Toda ação com side effect persistente passa por verificação prévia. Toda decisão sobre cortar tem fallback se a medição estiver errada. Toda inferência epistemicamente incerta declara o que **não** mediu.

Um agente que roda dentro do terminal, fala a língua do terminal, e morre quando você fecha o terminal. Sem GUI, sem Electron, sem servidor obrigatório, sem login. Você abre, conversa, ele edita arquivos, executa comandos, aprende com o repo. Fecha. SQLite local guarda tudo. Reabre amanhã, continua.

A diferença entre esse agente e wrappers de API que correm na mesma direção é uma só: **disciplina de medir antes de cortar**, exposta em todas as camadas. Plan mode mede o plano antes de escrever. Permission engine mede policy antes de invocar. Validator mede output antes de aceitar. Checkpoint mede estado antes de mutar. Eval mede regressão antes de mergear. `not_checked` declara o que ficou fora da medição. `assumptions` declara o que foi medido por assumir, não por verificar.

Público: dev sênior que vive em tmux/ssh, desconfia de wrappers, e quer **controlar o loop**.

**Killer use case**: trabalhar com modelo local (Ollama, llama.cpp) com a mesma confiabilidade que com frontier. Para isso, o agente suporta dois perfis de execução — `autonomous` (frontier-best, modelo orquestra) e `orchestrated` (local-best, harness orquestra DAG de steps pequenos com validators). Mesmas primitivas, orquestração diferente. Ver §5.2.

---

## 0.1 Documentos complementares

Este documento (`AGENTIC_CLI.md`) é a spec arquitetural de alto nível. Detalhes operacionais e contratos formais ficam em arquivos dedicados:

| Doc | Escopo | Quando consultar |
|---|---|---|
| [`PLAYBOOKS.md`](./PLAYBOOKS.md) | Templates de subagents especializados (review, audit, debug) | Ao desenhar workflow especializado ou criar slash command |
| [`MEMORY.md`](./MEMORY.md) | Subsistema de memória cross-session (4 tipos, escopo, anti-injection) | Ao implementar memory tools, ou avaliar segurança |
| [`CONTRACTS.md`](./CONTRACTS.md) | Contratos formais entre camadas (Tool↔Harness, Hook↔Harness, Provider↔Context, etc) | Ao implementar qualquer subsistema novo, ou debugar integração |
| [`STATE_MACHINE.md`](./STATE_MACHINE.md) | Máquinas de estado formais (sessão, step, tool, DAG, subagent) + crash recovery | Ao implementar harness, ou debugar resume após crash |
| [`ORCHESTRATION.md`](./ORCHESTRATION.md) | Coordenação de timing: master loop, DAG, subagent semantics, compaction, hooks, critique placement, cancellation, budget cascading, hybrid routing | Ao implementar qualquer coordenação entre subsistemas; pra resolver "quando X roda relativo a Y" |
| [`FAILURE_MODES.md`](./FAILURE_MODES.md) | Catálogo de falhas com playbook de recovery, audit, mensagens-template | Ao implementar tratamento de erro, ou triagem de incidente |
| [`SECURITY_GUIDELINE.md`](./SECURITY_GUIDELINE.md) | Threat model STRIDE, trust boundaries, attack vectors, defense layers, secret handling, supply chain, signing, disclosure process | Antes de implementar qualquer feature com side effect; ao revisar PR de segurança; pré-release |
| [`AUDIT.md`](./AUDIT.md) | Append-only convention, timeline unificada, PII redaction antes-de-persistir, hash chain (tamper-evident), forensics bundle format, `agent audit` CLI, schema versioning, GDPR hooks | Ao implementar audit/forensics; ao definir retention; ao adicionar tabela de audit nova |
| [`EVICTION.md`](./EVICTION.md) | Lifecycle e despejo tipado cross-substrato (memory, policy, candidate, slot item) — 7 estados canônicos, state machine, gates de evidência + proteção, tombstones com retention window, decay × eviction separados, compaction como eviction efêmera | Ao implementar lifecycle de qualquer substrato persistente; ao auditar "por que isso sumiu?"; antes de adicionar mecanismo de "esquecimento" |
| [`PROVIDERS.md`](./PROVIDERS.md) | Catálogo de providers, capabilities matrix, quirks documentados, recomendações por workflow, eval multi-model strategy | Ao adicionar provider novo, ou ao escolher provider pra workflow específico |
| [`LOCAL_MODELS.md`](./LOCAL_MODELS.md) | Hardware detection, model lifecycle, tool calling adapters, constrained generation, embeddings strategy, prompt template dialects, setup/bootstrap, remote Ollama, failure modes locais, privacy verifiable | Ao rodar com Ollama/llama.cpp; pra detalhamento operacional além do PROVIDERS.md |
| [`TOKEN_TUNING.md`](./TOKEN_TUNING.md) | Sampling params (temperature, top_p, top_k, penalties, seed), output budget per call, stop sequences, reasoning effort, multi-sample, truncation strategies, tokenizer accuracy, per-workflow defaults, eval-driven tuning | Ao definir sampling em playbook novo; ao adicionar provider; ao tunar workflow com eval |
| [`CONTEXT_TUNING.md`](./CONTEXT_TUNING.md) | Shape do prompt: system prompt architecture, layout + cache breakpoints, memory loading, tool palette, few-shot strategy, format choices, attention positioning, per-step shaping, goal re-injection, repo map injection, selective inclusion, per-workflow recipes | Ao desenhar/tunar contexto de prompt; pareceria com TOKEN_TUNING (tuning de generation) |
| [`RETRIEVAL.md`](./RETRIEVAL.md) | Pipeline `query → candidates → expansion → ranking → compression → context slot` em três views (workspace, session, memory). Decide **WHAT** entra no contexto dado um goal. Ranking auditável (lexical/estrutural primeiro, embedding opt-in v2), expansion bounded, trace obrigatório | Ao decidir o que entra no contexto; antes de propor "memória infinita" ou RAG; ao integrar compaction = retrieval re-query |
| [`PERFORMANCE.md`](./PERFORMANCE.md) | SLOs, budgets de latência, custo por tarefa, regression strategy | Ao otimizar hot path, ou definir threshold de regressão em CI |
| [`UI.md`](./UI.md) | Modelo inline, event bus, render funcional, componentes (tool card, modais, status line), paleta/glyphs/microcopy, headless `--json`, fallbacks. Sem framework. | Ao implementar qualquer parte da TUI ou definir microcopy de erro |
| [`RECAP.md`](./RECAP.md) | Vista projetada de sessões (PR/changelog/slack/etc), source-of-truth determinística + LLM renderer | Ao implementar `/recap`, ou gerar artefato a partir de sessão |
| [`ANTI_PATTERNS.md`](./ANTI_PATTERNS.md) | Padrões deliberadamente rejeitados (undercover mode, prompt-as-IP, persona tuning, vector DB, multi-model router, auto-commit, anti-patterns de MCP) com motivo e gatilho de reconsideração | Antes de adicionar feature que parece útil mas conflita com princípios; ao revisar PR de scope creep |
| [`MCP.md`](./MCP.md) | Spec consolidada de MCP — lifecycle, transport (stdio/SSE/HTTP), capability negotiation, manifest format e hash, namespacing, per-server budget, sandbox, cache impact, slash commands, observabilidade | Ao integrar MCP server novo; ao implementar cliente MCP; ao auditar trust history |
| [`IPC.md`](./IPC.md) | Canal vivo pai↔filho (subagent) via stdin/stdout NDJSON — message taxonomy, lifecycle, soft-stop propagation, backwards compat com one-shot, anti-patterns, migration por slice | Ao implementar subagent observability (1.f.2); ao propagar soft-stop pra subagents (D159); ao desenhar permission proxy entre pai e filho |
| [`CODE_INDEX.md`](./CODE_INDEX.md) | Subsistema de indexação de código — schema SQLite (symbols/references/imports), pipeline (initial scan + incremental + FS watcher opt-in), API queryable, multi-language tree-sitter, integração com repo map, tools simbólicas candidatas, invalidação, privacy | Ao implementar code index; ao adicionar tool simbólica nova; ao tunar repo map ou estratégia de retrieval |
| [`CODE_GENERATION.md`](./CODE_GENERATION.md) | Pipeline canônico de geração — generate → format → lint → test → checkpoint → accept; modos de strictness; integração com playbooks; per-language config; audit footprint; anti-patterns | Ao implementar PostToolUse hooks de generation; ao definir strict mode em playbook; ao debugar pipeline failure |
| [`FEATURE_FLAGS.md`](./FEATURE_FLAGS.md) | Governance mínima de flags — categorias (CLI/config/slash/state), lifecycle (experimental→staged→stable→deprecated), inventário canônico, audit (`feature_flags_active`), discovery (`agent --list-flags`, `/flags`), eval integration, anti-patterns | Ao introduzir flag nova; ao promover/depreciar; ao auditar bypass flags em CI |
| [`FEEDBACK_ADAPTATION.md`](./FEEDBACK_ADAPTATION.md) | Aprendizado operacional harness-side — dois loops (quente per-action / frio per-trigger), tiers de feedback (1-5), unidade adaptável (L1 alias → L4 strategy), calibração bayesiana com prior, invalidação > decay, escopo hierárquico (session → repo → user → language → global). Modelo nunca é notificado da adaptação | Ao propor "agent que aprende"; ao calibrar policies de permission/retrieval/context; antes de adicionar LLM-as-judge |

Spec arquitetural sem esses docs é descrição de uma implementação. **Com** esses docs vira protocolo que múltiplas implementações respeitam.

---

## 1. Princípios (não-negociáveis)

**0. Meça duas vezes, corte uma.** Premissa central da qual os outros princípios derivam. Toda ação com side effect persistente passa por verificação prévia. Toda decisão sobre cortar tem fallback (checkpoint, undo, replay). Toda medição declara seus limites (`not_checked`, `assumptions`, `confidence`). Os 12 princípios abaixo são instâncias específicas desta diretriz aplicadas a domínios concretos.

*Onde não se aplica:* operações idempotentes/leves (input echo, streaming de tokens, leitura de arquivo, hooks `Notification`) seguem outras regras — latência percebida e fluidez. O princípio rege **ações com efeito persistente**, não toda micro-operação.

---

1. **Terminal-first, não terminal-also.** Toda decisão de UX assume terminal como ambiente nativo, não fallback de uma web app.
2. **Determinismo em volta do caos.** O LLM é o único componente não-determinístico. Resto é previsível, auditável, replayável.
3. **Tool ergonomics > tool quantidade.** 10 tools bem desenhadas vencem 40 genéricas.
4. **Eval é load-bearing.** Sem regressão automatizada, qualquer mudança de prompt é roleta.
5. **Single runtime.** Multi-language vira protocolo, protocolo vira bug. Só fragmenta quando dor for real.
6. **Local-first, cloud-optional.** SQLite, filesystem, sem daemon obrigatório.
7. **Trace tudo.** Se não dá pra reproduzir um turno, não existe.
8. **Permissões e hooks como dado, não como `if`.** Política e extensão declarativas, versionadas, diff-able.
9. **Pipeable por padrão.** `cat prompt.txt | agent` funciona. Output JSON via flag.
10. **Reversível por design.** Toda escrita tem checkpoint. `/undo` é cidadão de primeira classe.
11. **Confiança explícita, nunca implícita.** Diretório novo = pergunta. `AGENTS.md` é input não-confiável até prova em contrário.
12. **Sem cargo cult.** Sem vector DB no v1. Sem multi-model router *por task*. Adicionar quando dor existir, não quando blog post existir.
    *Asterisco honesto:* "sem planner explícito" vale para profile `autonomous` (frontier orquestra). Para profile `orchestrated` (modelo local), planner DAG-based **é necessário** — modelo pequeno não decompõe sozinho de forma confiável. A regra geral vira: *sem cargo cult, mas com escolhas conscientes por capability do modelo.*

13. **Provider-pluggable, não provider-parity.** Adapters de provider são intercambiáveis no nível da API; qualidade, custo, e features são heterogêneos e ficam **declarados**, não escondidos. Sem vendor primary hardcoded; defaults vêm da config do usuário. Recomendações por workflow vêm de eval empírico, não de marketing. Pretender paridade entrega lowest-common-denominator; declarar heterogeneidade entrega decisão informada. Detalhe em [`PROVIDERS.md`](./PROVIDERS.md).

---

## 1.1 Invariantes operacionais

Corolários operacionais dos princípios §1, escritos como regras verificáveis. Cada invariante existe porque um foot-gun recorrente em sistemas similares justifica documentá-lo explicitamente. Próximas slices devem citar o invariante violado quando propuserem exceção.

### 1.1.1 Verifier hierarchy doctrine

**Regra:** *Use o mecanismo mais barato que resolve o problema. Saltar níveis é foot-gun por default.*

Pilha de verificação por custo (latência típica, custo USD por chamada):

| Mecanismo | Latência | $ / chamada | Domínio |
|---|---|---|---|
| `stat` / `existsSync` | ~0.001 ms | $0 | Exact lookup (path-existence, file-shape) |
| `grep` / regex | ~10 ms | $0 | Pattern search em texto conhecido |
| SQLite indexed query | ~1 ms | $0 | Structured lookup em audit / state |
| Embedding similarity | ~50 ms | ~$0.0001 | Semantic clustering, near-dup detection |
| LLM call (Haiku-class) | ~1000 ms | ~$0.001 | Semantic judgment, paraphrase, single-doc reasoning |
| LLM call (Sonnet-class) | ~2000 ms | ~$0.005 | Complex multi-step reasoning, multi-source synthesis |
| LLM subagent (multi-tool) | ~30000 ms | ~$0.05 | Exploratory analysis, governance proposal generation |

**Aplicação:**

- Slice nova que precisa de verificação DEVE escolher o nível mais baixo que cobre o caso documentado e **justificar por que não usou o anterior**.
- "LLM cobre tudo" é arquitetura cara + lenta + não-determinística sem ganho. Usar LLM em path-existence é gasto desnecessário de ~5-6 ordens de grandeza.
- "Heurística sempre" é frágil em domínios semânticos. Quando o caso documentado envolve paráfrase, equivalência conceitual ou síntese — LLM é apropriado.
- Hybrid stack: heurística pega o cheap path, retorna `unknown` no resto; LLM como fallback opt-in sobre o `unknown` set. Custo escala com complexidade real, não com volume.

**Pull-in signal para overrider:** dados empíricos mostrando que o nível inferior tem false-negative rate intolerável para o caso de uso. Sem dados, ficar no nível barato.

**Excepção subsistema-específica documentada — memory:** o memory subsystem do Forja optou deliberadamente por **zero text-heuristic** para decisões de lifecycle (S2 verify_failed e S4 conflict_detected ambas tentaram extratores regex sobre prose e foram revertidas — análise empírica mostrou que distinguir "memória afirma X" de "memória menciona X em contexto histórico" requer compreensão semântica que regex não entrega). A doutrina geral acima continua válida (use o mais barato que resolve), mas no memory subsystem **a camada heurística é intencionalmente vazia** para essa classe de decisão: todo julgamento sobre prose vai para LLM-judge via S8 governance proposals (`MEMORY.md §11.3`). Substrato determinístico (state machine, audit, frontmatter, hashing, expiry, scope precedence, file existence checks) e dials numéricos (BM25 weights, quarantine penalty) ficam — não são "judgment over prose".

### 1.1.2 No-daemon discipline

**Regra:** *Forja é per-CLI-invocation. Não há processo de longa duração entre sessões. Cross-session work acontece em boot sweeps, não em background.*

**Aplicação:**

- Sweeps de retenção (eviction tombstone purge, provenance prune, governance proposal expire) rodam **at boot**, com janela documentada (90d / 30d) — não em timer/cron interno.
- Detectores e governance que precisam de "monitoramento contínuo" devem ser reformulados como "verificação at boot" ou "verificação at step boundary" dentro da sessão.
- Subagents existem e correm async, mas dentro do escopo de **uma sessão** (`task_async` handle store é drenado no outer finally do `runAgent`).
- Cron / scheduled work cross-session é responsabilidade do operator (cron + `agent` invocation), não do binário.

**Por que:** processo background introduz classe inteira de bugs (zombie processes, db lock contention, signal handling em ambientes restritivos, recovery após crash) que a infra atual não modela. Inverter essa decisão requer projetar lifecycle de processo separado, IPC entre instâncias, lock files, etc. — escopo de subsistema novo.

**Pull-in signal:** caso de uso documentado que **não pode** ser modelado como boot sweep ou step-boundary. Hoje nenhum existe.

### 1.1.3 Append-only everywhere

**Regra:** *Substrato de audit nunca muta retroativamente. Tudo que parece mutação é INSERT de nova row + ponteiro pro estado anterior.*

**Aplicação:**

- `memory_events`, `eviction_events`, `memory_provenance`, `memory_governance_proposals`: tabelas append-only. UPDATE permitido apenas em campos de status discriminantes (e.g., `governance_proposals.status: pending → applied/rejected/expired`), nunca rewrite de payload.
- Mutações lógicas (state transition, memory rewrite) viram audit-row + paired transition-row. O histórico do conteúdo vive em commit history do filesystem + tombstones; o histórico do estado vive em eviction_events parent-chain.
- Sweeps de retenção são a **única** operação DELETE permitida nesses substratos, com janela explícita documentada em constante exportada.
- Migration que adicionar campo NOVO em audit table é OK; migration que reescreve rows existentes (backfill que não seja idempotente sobre `created_at`) **requer justificativa documentada**.

**Por que:** replay forense + audit reconciliation + detector quality measurement dependem de imutabilidade. Uma rewrite silenciosa quebra a premissa que faz audit valer mais que log.

### 1.1.4 Confidence ≠ authority

**Regra:** *Scores de confidence guiam ranking e decay — nunca authorization. Authorization vem de: (a) operator explicit approval, (b) deterministic state-machine validation, (c) heuristic com zero false-positive shape.*

**Aplicação:**

- `memory_governance_proposals.confidence` é input para ordenação na UI e para gate de "auto-archive abaixo de threshold". **Nunca** input para "auto-apply acima de threshold".
- Truth confidence em frontmatter (proposta em S12) impacta retrieval ranking, **não** auto-mutation.
- "Auto-apply at confidence > 0.95" é refused by design — confidence é estimativa probabilística do modelo sobre si mesmo, não autorização para alterar estado persistente.
- Apply path SEMPRE requer evento de authorization explícito (operator approval row, state machine `applied` outcome).

**Por que:** confiar em confidence para auto-aplicar cria caminho de **recursive epistemic corruption**: memória ruim → LLM gera proposal high-confidence → auto-apply → estado degrada → futura geração de proposals piora. Separar confidence de authority quebra o loop.

**Pull-in signal:** apenas se um detector tiver false-positive rate empiricamente medido em **zero** em corpus suficientemente grande — e mesmo assim, com kill-switch operacional.

### 1.1.5 Injection surface ledger

**Regra:** *Toda superfície onde bytes de memory body podem entrar em janela de modelo é listada explicitamente. Adicionar nova superfície requer: (a) entrada nesta lista, (b) revisão do trust filter, (c) `scanForInjection` pre-check.*

**Superfícies hoje:**

1. **Eager system prompt** (boot). Filtered: `frontmatter.trust === 'untrusted'` exclui o body do prompt. Index entry (name + description) ainda surface.
2. **`memory_read` tool response** (per-call). Full body returned ao modelo via tool result. Trust marker propagated em `out.trust`; renderer surface "[memory: untrusted]" warn no terminal.
3. **`retrieve_context` slot** (per-call). Full body em `level='full'`, comprimido em `outline/summary/ref`. Inclusão é gateada pelo compression resolver; não tem trust filter dedicado hoje (gap conhecido — `MEMORY.md §14.3`).
4. **Governance subagent input** (planejado em S11). Bodies passam por `scanForInjection` pre-check; system prompt enquadra input como adversarial; output JSON-schema-validated.

**Aplicação:**

- PR que adicionar nova superfície (ex.: novo tool que retorna memory body, novo subagent que lê memory) DEVE adicionar entrada nesta lista. PR review check.
- Trust filter (`frontmatter.trust === 'untrusted'` rejection) é o gate canônico — futuras superfícies devem usar a mesma helper, não reimplementar.
- `scanForInjection` é o pre-check canônico para LLM-consumer surfaces — futuras superfícies LLM devem chamar antes de emitir bytes no prompt.

**Por que:** memory bodies são operator-edited e alguns são imported (FEEDBACK_ADAPTATION cross-cut). Tratá-los como input não-adversarial em qualquer superfície reabre o vetor que o trust filter existe para fechar. Sem ledger central, próximo developer adiciona a 5ª superfície sem perceber que está bypassando uma camada de defesa.

### 1.1.6 Proposal staleness check

**Regra:** *Toda governance proposal carrega snapshot do estado das memórias referenciadas no momento da criação. Apply path verifica os snapshots contra estado CURRENT antes da transição; mismatch = `rejected`, não `applied`.*

**Aplicação:**

- Qualquer proposal que cite uma ou mais memórias por `(scope, name)` (governance proposals, eviction proposals, consolidation proposals — toda família `memory_governance_proposals` da §11.3) DEVE persistir `source_memory_snapshots: { scope, name, content_hash }[]` no momento da criação.
- O apply path computa `hashMemoryContent(serializeMemoryFile(current_file))` para cada memória citada e compara com o snapshot. Qualquer mismatch → status='rejected', `decided_by='system:stale_evidence'`, reason inclui qual memória drifou.
- O check roda ANTES da verificação de state (memory has changed state since proposal) — drift de conteúdo é o sinal mais informativo para o operator ("a memória mudou desde que eu propus isso" é mais útil que "memória já não está active").
- **Caso especial — memória citada não existe mais** (deletada entre proposal creation e approval): `readMemoryByName` retorna `missing`/`unknown` → rejection com `decided_by='system:memory_gone'`, distinto de `system:stale_evidence`. Os dois são UX semanticamente diferentes pro operator (memória "editada" vs memória "sumiu"); rejection reason carrega a distinção pra slash render.
- **Caso especial — proposal sem source_memory_keys** (e.g., hipotético `kind='create'` propondo memória nova): `source_memory_snapshots` é array vazio; o check passa por vacuidade (nada pra comparar) e o apply path prossegue para validação de state + transição normal.

**Por que:** propose-not-mutate (§1.1.4) tem latência entre criação e aprovação. Sem snapshot check, o operator aprova hoje uma proposal cuja evidência reflete o estado de N dias atrás — pior caso, autoriza mutação contra body completamente diferente do que a evidência da proposal cita. O snapshot fecha o gap: o invariante operacional é "approval ratifica evidência no contexto em que foi gerada; se contexto drifou, evidência expira".

**Pull-in signal para overrider:** nenhum — esse é defesa estrutural barata (1 hash extra por proposal, 1 comparison no apply). Sem custo significativo, sem trade-off operacional.

A maioria dos projetos coloca "CLI" no nome e entrega uma interface web mal portada pra terminal. Aqui não.

### 2.1 Modos de operação

| Modo | Trigger | Uso |
|---|---|---|
| **Interactive TUI** | `agent` (sem args) | sessão humana, streaming, slash commands |
| **One-shot** | `agent "prompt"` | tarefa única, output stream, sai ao terminar |
| **Headless** | `agent --json "prompt"` | scripts, CI, output NDJSON estruturado |
| **Pipe** | `cmd \| agent "prompt"` | stdin vira contexto adicional |
| **Plan** | `agent --plan "prompt"` | read-only; propõe plano sem aplicar |
| **Resume picker** | `agent --resume` (sem args) | listagem interativa de sessões com mini-recap inline |
| **Resume** | `agent --resume <id>` ou `agent --resume last` | continua sessão específica (id ou alias `last`) |
| **List sessions** | `agent --list-sessions [opções]` | lista sessões com filtros; JSON-friendly via `--json` |
| **Replay** | `agent --replay <id>` | re-executa sessão (debug/eval) |
| **Doctor** | `agent doctor` | diagnóstico do ambiente: runtime, providers, sandbox, capabilities, disk, configs, hooks, memory |
| **Init** | `agent init [--force[=csv]] [--mode strict\|acceptEdits] [--only=csv]` | scaffolda o bundle inicial em `.agent/` — `permissions.yaml`, `.gitignore`, `config.toml`, e os 10 playbooks canônicos sob `agents/`. Cada passo é idempotente (skip-if-exists); `--force` (bare = `all`; `--force=csv` = subset entre `permissions`, `config`, `playbooks`) sobrescreve. `--only=csv` restringe o scaffold a um subconjunto entre `permissions`, `gitignore`, `config`, `playbooks` (default: todos). Sem este passo o operador roda em strict default-deny (§8). Schema do `config.toml` scaffoldado em §2.1.1. |

#### 2.1.1 `config.toml` — scaffold slim + schema reference

`agent init` escreve um `.agent/config.toml` **slim**: apenas um header apontando pra esta seção, sem exemplos inline. Discovery do schema fica aqui, não no arquivo.

**Scaffold literal** (o que o `init` materializa em `.agent/config.toml`):

```toml
# .agent/config.toml — Forja per-project config (safe to edit).
#
# Schema: AGENTIC_CLI.md §2.1.1.
# Resolution order: enterprise → user (~/.config/agent/config.toml) →
# project (this file) → session (CLI flag).
#
# This file is empty by design. Add a [memory] or [critique] section
# to override loader defaults for this project. See the spec for the
# full toggle list; defaults live in code (src/critique/config-loader.ts).
#
# Note: `/memory governance enable|disable` rewrites this file and
# normalizes formatting (comments NOT preserved). Hand-edits to
# inactive sections survive; comments do not. Keep notes in the
# spec or your team's docs, not inline here.
```

**Por que slim e não rico-com-comentários.** O slash `/memory governance enable|disable verify|conflict|override|all` reescreve `config.toml` por round-trip (parse → mutate → emit), e `Bun.TOML.parse` não preserva comments. Um scaffold rico em comentários **perderia toda a documentação inline na primeira invocação do slash** — exatamente quando o operador acabou de aprender a usá-lo. Discovery via spec evita essa falsa promessa.

**Schema reference** — o conjunto canônico de toggles que `config.toml` aceita. Defaults reais vivem em código (`src/critique/config-loader.ts`); a tabela abaixo é descritiva, não normativa pro template:

```toml
# [memory] — three LLM-judge governance detectors, all default ON.
# Setting a key to `false` DISABLES the corresponding detector for
# this project. Disabling does NOT delete past events or proposals;
# it only stops the scheduler from dispatching new ones.

[memory]
verify_semantic_llm = false   # S11: post-write semantic verification
conflict_detect_llm = false   # S13: cross-memory conflict detection
override_detect_llm = false   # S3: repeated-override threshold detector

# [critique] — write-time self-critique. Default mode = off.
# Setting `mode` to a non-`off` value ACTIVATES critique with the
# remaining fields. 'on_writes' fires only on edits; 'always' fires
# on every assistant turn. Model + prompt_version are illustrative —
# check `src/critique/config-loader.ts` for the current canonical
# defaults before adopting verbatim.

[critique]
mode = "on_writes"            # off | on_writes | always
threshold = 0.65              # 0..1; severity threshold to surface
model = "anthropic/claude-haiku-4-5"
prompt_version = "v1"

# [providers] — default executor model for this project. Pin here so
# CI / team members get the same model without remembering the
# --model flag. Resolution chain: CLI flag (--model) > project
# [providers].model > user [providers].model > DEFAULT_MODEL in code.

[providers]
model = "anthropic/claude-opus-4-7"   # any id in createDefaultRegistry()

# [budget] — per-project caps for the harness run budget. Each field
# is independently overridable; absent fields inherit DEFAULT_BUDGET
# from `src/harness/types.ts`. Resolution chain mirrors [providers]:
# CLI flag (--max-steps, --max-cost-usd, ...) > project [budget] >
# user [budget] > DEFAULT_BUDGET. Useful for CI where strict caps
# protect cost; useful for high-trust dev branches where steps need
# to grow past the default 200 backstop.

[budget]
max_steps = 200               # runaway-loop backstop; cost cap is the engagement gate
max_cost_usd = 5              # hard cap; harness aborts strictly above this value
max_wall_clock_ms = 600000    # 10 min default
max_step_stall_ms = 90000     # 90s per-step watchdog
compaction_threshold = 0.7    # fraction of context-window before compaction fires
compaction_preserve_tail = 3  # turns of conversation tail kept verbatim during compaction
```

Seções futuras (`[telemetry]`, …) entram aqui pelo mesmo padrão: **schema reference aqui no spec, scaffold mantém-se slim**. Schema-creep no `[…]` reference é aceitável (custo: linhas de spec); schema-creep nos defaults em código requer PR contra esta seção primeiro.

### 2.2 Composição (Unix philosophy)

- `stdin` é input válido. `stdout` é output puro. `stderr` é log/progresso.
- Em modo `--json`, **nada** vai pra `stdout` que não seja JSONL válido.
- Exit codes significam algo: `0` sucesso, `1` erro de tarefa, `2` budget exausto, `3` denied por policy, `130` interrompido.
- `agent --list-tools` imprime schema. `agent --version --json` imprime info estruturada. `agent --list-sessions --json` imprime sessões em NDJSON. Tudo scriptável.

#### Flags de `--list-sessions`

```
--limit N            últimas N sessões (default: 20)
--project PATH       filtra por cwd
--since DATE         filtra por data (>= YYYY-MM-DD ou "7d", "yesterday")
--status STATUS      done | exhausted | error | running | interrupted
--search QUERY       busca fuzzy em goal / first prompt
--with-recap         inclui mini-recap (1-line) por sessão (custo via Haiku, cacheado)
--json               output NDJSON pra scripting
```

Detalhe da projeção de mini-recap em [`RECAP.md`](./RECAP.md) §3 (`recap_mini` schema).

### 2.3 Capability detection

Detectar e adaptar, não exigir:

- **TTY?** Se não, modo headless automático.
- **Truecolor?** Se sim, syntax highlight rico. Se não, 16 cores. Se `NO_COLOR=1`, ASCII puro.
- **Unicode?** Detectar locale. Fallback ASCII pra spinners/borders.
- **Largura?** Reflow dinâmico em resize (`SIGWINCH`).
- **tmux/screen?** Detectar e ajustar (sem queries de cursor que quebram).
- **SSH?** Latência em mente; menos polling, mais event-driven.
- **Image protocol?** Kitty/iTerm2/WezTerm — habilita paste de imagem em v2.

### 2.4 Keyboard-only

Zero pressuposto de mouse. Todo fluxo navegável por teclado:

- `Ctrl+C` — interrompe (com dupla confirmação se tool em execução)
- `Ctrl+D` — sai
- `Ctrl+R` — search no histórico de prompts
- `Ctrl+L` — limpa tela (não o contexto)
- `Esc Esc` — interrompe modelo mas mantém input
- `Ctrl+Z` — desfaz último step (`/undo` por atalho)
- `Tab` — completion de slash commands e paths
- `↑/↓` — histórico
- `Alt+Enter` — newline em input (Enter envia)

### 2.5 Slash commands (descobertos via `/`)

```
/help              # lista comandos
/resume            # carrega sessão
/compact [foco]    # força compaction (opcional: hint do que preservar)
/cost              # custo da sessão (breakdown por tool/subagent)
/model <name>      # troca provider/modelo
/clear             # limpa contexto (mantém system)
/replay <id>       # re-executa sessão
/tools             # lista tools disponíveis
/perms             # mostra política ativa
/eval <name>       # roda eval contra estado atual
/plan              # entra em plan mode
/undo              # reverte último step (checkpoint)
/checkpoint        # list/restore/diff
/bg                # status de background processes
/hooks             # lista hooks ativos
/trust             # gerencia diretórios confiados
/review            # playbook: code review (read-only)
/audit             # playbook: security audit (read-only, reativo: input é código)
/debug             # playbook: hypothesis-driven debugging
/refactor          # playbook: scope-bounded refactor preservando semântica
/explain           # playbook: read-only explicação estruturada de código/sistema
/threat-model      # playbook: STRIDE-driven threat model (read-only, proativo: input é design)
/perf              # playbook: performance investigate (profiler-driven, não aplica fixes)
/git-hygiene       # playbook: sugere commit msg/branch/rebase (read-only, não executa)
/recap             # vista projetada da sessão atual (últimos N steps)
/recap session     # vista de sessão específica
/recap pr          # render como PR description
/recap changelog   # render como changelog entry
/recap slack       # render como mensagem Slack
/recap day         # cross-session no dia (mesmo projeto)
/recap json        # intermediate cru, sem LLM
/recap pre-compact # mostra o que vai ser compactado antes
/recap list        # mini-recap por sessão (alimenta SessionPicker)
/sessions list     # picker interativo de sessões com mini-recap inline
/sessions show     # detalhe + recap completo de uma sessão
/sessions switch   # interrompe atual, resume outra
/sessions current  # info da sessão ativa (id, custo, steps)
/memory list              # lista memórias do índice (scope: user|project|local|shared)
/memory show              # imprime conteúdo de uma memória
/memory edit              # abre $EDITOR
/memory delete            # remove memória (com confirmação)
/memory save              # propõe salvar baseado em sessão atual (default: local)
/memory promote shared    # project local → project shared (cria mudança git, sem auto-commit)
/memory demote local      # project shared → project local
/memory promote user      # project → user global (com confirmação dupla)
/memory audit             # tabela memory_events da sessão
```

Slash commands são **dados**: arquivos `.md` em `~/.config/agent/commands/`. Frontmatter declara nome/desc, corpo é o prompt. Usuário cria os seus.

### 2.6 Output design

- **Streaming token-by-token** sem buffering bobo.
- **Tool calls renderizados como cards colapsáveis** — input visível, output collapsado por padrão (long output não polui o histórico visual).
- **Diffs inline** com cores; nunca dump de arquivo inteiro.
- **TodoList live** quando o agente usa `todo_write` — checklist atualiza em tempo real.
- **Background processes tray** no rodapé com status.
- **Progress sem spam** — uma linha que se atualiza, não 200 linhas de log.
- **Custo/budget no rodapé** — sempre visível, nunca surpresa.

### 2.7 Config

Tudo em arquivo. Nada de GUI de config.

```
~/.config/agent/                 # PER-USER (global)
  config.toml                    # config global
  permissions.yaml               # policy global
  hooks.toml                     # hooks global
  commands/                      # slash commands custom
  agents/                        # subagent definitions
  playbooks/                     # playbooks especializados
  orchestrators/                 # DAGs
  memory/                        # USER scope memory
  trusted_dirs                   # workspaces confiados

~/.local/share/agent/            # PER-USER state (gitignored se aplicável)
  sessions.db                    # SQLite
  traces/                        # NDJSON por sessão
  checkpoints/                   # snapshots fora-do-git (fallback)

./.agent/                        # PROJECT-LEVEL (parcialmente versionado)
  config.toml                    # ✓ committed (config team-wide)
  permissions.yaml               # ✓ committed (policy team)
  hooks.toml                     # ✓ committed (hooks team; opt-in)
  playbooks/                     # ✓ committed (workflows do projeto)
  agents/                        # ✓ committed (subagents do projeto)
  commands/                      # ✓ committed (slash commands custom)
  orchestrators/                 # ✓ committed (DAGs)
  memory/
    shared/                      # ✓ committed (team-wide memory; PR-reviewed)
    local/                       # ✗ gitignored (per-user no projeto)
  sessions.db                    # ✗ gitignored (PII, grande)
  traces/                        # ✗ gitignored
  checkpoints/                   # ✗ gitignored (refs locais)
  .gitignore                     # auto-gerado pela primeira vez

./AGENTS.md                      # ✓ committed (contexto do projeto, não-confiável!)
```

XDG Base Dir respeitado. Override por env var (`AGENT_CONFIG_DIR`).

**Team-shared vs per-user:** tudo em `~/.config/agent/` é per-user (per developer). Tudo em `.agent/` é projeto-level: parte versionada (config team-wide, playbooks, memory shared), parte gitignored (sessions.db, traces, memory local). Outro colaborador clona o repo, abre o agente, e **imediatamente** tem acesso ao knowledge curado do time (memory shared + playbooks + permissions). Inferred memories ficam locais; promoção pra shared é ato explícito do user que cria mudança em `git status` — sem auto-commit. Detalhe em [`MEMORY.md`](./MEMORY.md) §2.2 e §5.4.

`.agent/.gitignore` é gerado automaticamente na primeira invocação se ausente. Conteúdo seguro por default; user pode editar livremente.

---

## 3. Stack

| Camada | Escolha | Motivo |
|---|---|---|
| Linguagem | **TypeScript** | Melhor SDK Anthropic + MCP TS-first + ecossistema agent denso |
| Runtime | **Bun** | Single-binary compile, fast startup, fetch nativo, SQLite embutido |
| Storage | **SQLite (`bun:sqlite`)** | Zero-setup, transacional, suficiente até 100M linhas |
| TUI | **Interno (raw ANSI + raw stdin)** | Inline render: histórico vai pro scrollback do terminal, só ~3-15 linhas vivas no fundo. Sem framework (sem React/Ink/blessed) — região viva é pequena demais pra justificar reconciliação. Deps mínimas: `string-width`, `wrap-ansi`. Ver [`UI.md`](./UI.md). |
| Provider | **Pluggable adapters** | Cada provider em módulo isolado conforme `Provider` interface. v1 inclui: Anthropic, OpenAI, Ollama, llama.cpp. Ver [`PROVIDERS.md`](./PROVIDERS.md). |
| Local backend | **Ollama** + **llama.cpp** (via HTTP) | Mais maduro pra modelos locais; GBNF grammar nativo no llama.cpp |
| Constrained gen | **GBNF** (llama.cpp) / **JSON mode** (Ollama) / **tools** (Anthropic) | Force schema adherence em modelo pequeno |
| Repo map | **tree-sitter** | Símbolos compactados sem grep storm; essencial em profile orchestrated |
| MCP | **`@modelcontextprotocol/sdk`** | Padrão de fato pra tools externas |
| Sandbox | **`bwrap`** (Linux) / **`sandbox-exec`** (macOS) | Isolamento real do `bash` |
| Telemetry | **OpenTelemetry** + NDJSON local | Padrão; exporta pra Honeycomb/Jaeger se quiser |
| Eval | **Vitest + dataset YAML** | Mesma stack do código; sem framework custom |

Alternativas honestas: Python se a equipe é ML-heavy; Go só se sandbox de tools virar problema real.

Distribuição: `bun build --compile` gera binário único por plataforma. Sem `node_modules` no usuário. `curl | sh` instala.

---

## 4. Topologia

```
┌─────────────────────────────────────────────────────────┐
│  CLI / TUI (raw ANSI + event bus)                       │  I/O, streaming, interrupts
├─────────────────────────────────────────────────────────┤
│  Session Manager                                        │  lifecycle, persist, resume
├─────────────────────────────────────────────────────────┤
│  Hooks Dispatcher                                       │  events → user commands
├─────────────────────────────────────────────────────────┤
│  Orchestrator (profile-aware)                           │  autonomous | orchestrated | hybrid
│    ├─ Agent Harness (freeform loop)         [autonomous] │
│    └─ Step Graph Executor + Validators      [orchestrated]│
├─────────────────────────────────────────────────────────┤
│                ←→  Subagent Pool                        │
├─────────────────────────────────────────────────────────┤
│  Context Engine  │ Repo Map │ Checkpoint Manager        │  assembly + map + rollback
├─────────────────────────────────────────────────────────┤
│  Tool Registry  ←→  Permission Engine  ←→  Sandbox      │  schemas, policy, isolation
├─────────────────────────────────────────────────────────┤
│  Provider Layer (LLM)  ←→  Constrained Gen Backend      │  Anthropic | OpenAI | Ollama | llama.cpp
├─────────────────────────────────────────────────────────┤
│  Model Registry (capabilities + prompt templates)       │
├─────────────────────────────────────────────────────────┤
│  Storage (SQLite) │ Telemetry │ Eval Harness            │
└─────────────────────────────────────────────────────────┘
```

Cada camada tem **um único motivo pra existir**. Se a fronteira não cabe em uma frase, ela não existe.

---

## 5. Agent Harness (o coração)

```ts
interface Step {
  id: string
  parent?: string          // subagent tracking
  input: ContextWindow
  output: AssistantMessage
  toolCalls: ToolCall[]
  tokens: { in: number; out: number; cached: number }
  costUsd: number
  durationMs: number
  checkpointId?: string    // se houve escrita
}

interface RunBudget {
  maxSteps: number              // default 200 — backstop, não engagement gate
  maxCostUsd?: number           // default 5; explicit `undefined` = operator opt-out
  maxWallClockMs: number        // default 600_000 (10min)
  maxToolErrors: number         // default 5 consecutivos
  maxRepeatedToolHash: number   // default 3 (mesma tool+input em 5 steps)
}
```

#### Postura cost-primary

`maxCostUsd` é o **engagement gate**: define até onde a sessão pode ir em valor real. `maxSteps` é **backstop** contra runaway loop, não o limite de ambição da sessão. Refactor multi-arquivo, audit profundo, ou debug iterativo legítimo precisam de muitos passos pequenos — cortar por contagem quando o custo está dentro do orçamento descarta trabalho válido. O `degenerate-loop tracker` (`maxRepeatedToolHash`) e o contador de erros (`maxToolErrors`) detectam patologia genuína bem antes do `maxSteps`; este último só dispara quando os outros sinais falham, e 200 dá margem pra sessões ambiciosas sem desabilitar a proteção.

`maxCostUsd` é opcional **apenas pra suportar opt-out explícito** (CI runners, eval com enforcement próprio, sessões locais sem providers pagos). O shape `?: number | undefined` distingue três estados: campo ausente → merge com default 5; campo presente como `undefined` → operador opta out e o gate não dispara; campo numérico → esse cap. Operadores típicos não tocam — o default 5 cobre o uso comum, e `/budget cost <USD>` ajusta. `/budget cost off` escreve o `undefined` explícito.

Loop com **três tipos de saída**:

- `done` — modelo retornou sem tool call
- `interrupted` — usuário cancelou (AbortSignal propaga)
- `exhausted` — budget estourou (estado, não erro)

#### Matriz de interação dos limites

Cada limite tem warning threshold (soft) e cap (hard). Hit qualquer hard cap = `exhausted`.

| Limite | Soft warning | Hard cap action | Observação |
|---|---|---|---|
| `maxSteps` | 80% (160/200) — UI mostra `⚠ 160/200` | hit → step atual termina, sessão `exhausted` | step em andamento sempre conclui; backstop, não engagement gate |
| `maxCostUsd` | 80% — UI mostra `$4.00/$5.00` em amarelo; 90% em vermelho | hit → step atual recebe sinal pra finalizar; novos spawns rejeitados; eventual `exhausted` | provider call em curso conclui (cost extra contado) |
| `maxWallClockMs` | 80% — UI mostra clock no rodapé | hit → `interrupt_signal` paralelo (ORCHESTRATION §7); cleanup; sessão `interrupted` (não `exhausted`) | distinto: time-based é interrupt, não exhausted |
| `maxToolErrors` | 4 erros consecutivos — warning no rodapé | 5 erros consecutivos → `exhausted_errors`; sessão `error` (recoverable via resume) | reset em step bem-sucedido |
| `maxRepeatedToolHash` | 2× hash idêntico → warning | 3× hash idêntico em 5 steps → `degenerate_loop`; sessão `error` | hash = SHA256 de `JSON.stringify(args, sortedKeys)` |

#### Loop degenerado detection (detalhado)

Erros de tool **não param o loop por padrão** — viram tool result e o modelo decide. Detection de **degenerate state**:

1. **Erros consecutivos** (`maxToolErrors`): contador de erros em sequência (qualquer tool). Reset em primeiro sucesso. Hit cap = aborta loop com `exhausted_errors`.

2. **Tool repetition hash** (`maxRepeatedToolHash`): para cada step com tool_use, computa `input_hash` = SHA256 dos args. Persistido em `tool_calls.input_hash`. Janela deslizante de 5 steps; se ≥ 3 hashes idênticos pra mesma tool, abort com `degenerate_loop`.

3. **Wall-clock per step** (não default): step individual > 5min sem progresso (sem tool_use, sem stop) — abort com `step_stalled`. Configurável em `maxStepStallMs`.

Action em qualquer detection: aborta loop, marca sessão `error`, mensagem clara ao user com qual detection disparou e como proceder. Resume limpa contador (próxima sessão começa fresh).

Cada step é uma transação SQLite. Crash mid-step → estado consistente no resume.

### 5.1 Modos de execução

Três modos selecionáveis por flag/slash command:

- **`run`** (default) — executa, edita, age. Sujeito a permissions.
- **`plan`** — read-only. Tools que escrevem (`write_file`, `edit_file`, `bash` com efeito) ficam **bloqueadas no nível do harness**, não na policy. Modelo explora, propõe plano. Saída do plan = texto, não diff aplicado.
- **`acceptEdits`** — auto-aprova edits dentro de `allow_paths`. Útil em sessão longa de refactor.

Transição: `/plan` entra em plan mode; ao final, harness apresenta o plano e pergunta `executar? [a]ccept · [e]dit · [r]eject`. Resposta `a` → reentra em `run` com o plano injetado como goal estruturado.

Plan mode **não é o mesmo que "planner explícito"**. Não há decomposição forçada — só uma trava de escrita. O modelo decide quanto explorar.

#### Plan output schema (formal)

Plan mode tem **output estruturado**, não prosa livre:

```yaml
plan:
  goal: string                        # ecoa user prompt original
  scope:
    files: [string]                   # in-scope, paths concretos
    not_in_scope: [{ area, reason }]  # explicitamente fora
  steps:
    - id: int
      description: string
      files_affected: [string]
      semantic_preserving: bool
      requires_test_run: bool
      estimated_cost_usd: float        # opcional, hint do modelo
  risks: [string]                     # o que pode dar errado
  not_planned:
    - { area, reason }
  assumptions: [string]
```

Schema é **subset do `refactor` playbook** (§5 PLAYBOOKS.md) — reutiliza convenções.

#### Fluxo plan → execute

1. User entra em plan mode (`/plan` ou `agent --plan "..."`)
2. Modelo explora (read-only) e produz `plan` no schema acima
3. Harness apresenta como markdown estruturado via modal de plan review (UI.md §4.9)
4. User decide:
   - `[a]ccept` — sai de plan mode; reentra em `run` com plan injetado como goal estruturado; harness executa **etapa por etapa** (cada step do plan vira sub-goal), com checkpoint entre etapas
   - `[e]dit` — abre `$EDITOR` no plan YAML; user modifica; volta pra escolha
   - `[r]eject` — descarta plan; sessão volta a `idle`
5. Em modo `run` pós-accept: harness usa **mesma mecânica do refactor playbook** (etapas com test-gate)

UI: modal de plan review renderizado via `plan:review` event + modal pattern canônico (UI.md §5.5). Diff é impresso como conteúdo permanente acima do modal.

### 5.2 Execution Profiles

Profile = quem orquestra o trabalho. **Mesmas primitivas (sessions, tools, hooks, checkpoints), orquestradores diferentes.** Selecionado por sessão, auto-detectado por capability do modelo.

| Profile | Quem orquestra | Loop | Modelos-alvo |
|---|---|---|---|
| `autonomous` | Modelo decide tool e quando parar | Freeform ReAct | Claude Opus/Sonnet, GPT-4/5, modelos com tool calling forte |
| `orchestrated` | Harness executa DAG; modelo só preenche steps | State machine | Llama-3, Qwen, Mistral, DeepSeek-Coder (7B–30B) |
| `hybrid` | Frontier planeja, local executa, frontier valida em fallback | DAG misto | Combinação Ollama+Claude para custo baixo + privacidade |

Auto-seleção via Model Registry (ver §14). Override por flag (`--profile orchestrated`) ou config.

### 5.3 Step Graph Executor (profile `orchestrated`)

Em vez de `while (model_calls_tool)`, harness executa um **DAG de nós**, cada um com prompt curto, tools restritas, schema validado.

```yaml
# orchestrators/edit_function.yaml
version: 1
inputs: { goal: string }
nodes:
  - id: locate
    type: llm
    prompt_template: locate_function
    tools: [grep, glob]
    output_schema:
      file: string
      line: int
    validators: [file_exists]
    on_failure: { retry: 2, hint: "use grep -n com nome exato" }

  - id: read_context
    type: llm
    prompt_template: read_around
    tools: [read_file]
    inputs_from: [locate]
    output_schema: { context: string, deps: [string] }

  - id: propose_edit
    type: llm
    prompt_template: propose_edit
    inputs_from: [locate, read_context]
    output_schema: { old_string: string, new_string: string, rationale: string }

  - id: validate_edit
    type: deterministic         # zero LLM
    fn: ast_validate
    inputs_from: [propose_edit, locate]

  - id: apply
    type: tool
    tool: edit_file
    inputs_from: [validate_edit]
    requires_confirm: true
```

**Tipos de nó:**
- `llm` — chama modelo com prompt + tools restritas + schema
- `deterministic` — função TS pura (AST check, regex, file exists, lint)
- `tool` — chama tool diretamente (sem LLM intermediário)
- `subgraph` — invoca outro DAG

**Fluxo:**
1. Executor topologically-sort os nós
2. Para cada nó `llm`: prompt minúsculo + 2-3 tools + grammar/schema enforced
3. Validador roda; falha → retry com `hint` (≤2 tentativas) → fallback ou aborto
4. Output do nó persiste em `step_outputs` (auditável, replayable)
5. Próximo nó consome via `inputs_from`

**Por que isso funciona em modelo pequeno:**
- Cada step tem escopo trivial (modelo de 7B aguenta)
- Tool palette restrita (3 tools, não 12)
- Schema enforced via grammar (não chuta sintaxe)
- Validator pega lixo determinísticamente
- Goal não precisa ser "lembrado" — está no DAG

**Por que isso é desnecessário em frontier:**
- Frontier decompõe sozinho melhor que DAG humano
- Validators redundantes
- Latência sobe sem ganho de qualidade
- Só vale quando custo importa muito

DAGs ficam em `~/.config/agent/orchestrators/*.yaml`. Comunidade pode publicar/compartilhar. Eval acoplado por DAG.

### 5.4 Self-critique pass (opt-in)

Agente **principal** gera output → modelo **critic** revisa antes de mostrar ao user. Catches bugs próprios; instância retrospectiva imediata de "meça duas vezes".

#### Configuração

```toml
# ~/.config/agent/config.toml ou .agent/config.toml
[critique]
mode = "off"                       # off | on_writes | always
model = "anthropic/haiku-4-5"      # cheap; sem vendor lock-in
prompt_version = "v1"
threshold = 0.7                    # confidence mínimo pra apresentar warning
max_overhead_ms = 3000             # se ultrapassa, skip critique (não bloqueia)
```

**Modes:**
- `off` (default) — nunca roda. Sem custo, sem latência extra.
- `on_writes` — roda apenas em steps com tool de escrita (`writes: true`). Sweet spot.
- `always` — roda em todo step. 2x latência, 2x custo de raciocínio.

#### Fluxo

1. Step principal completa output (assistant message + tool calls)
2. Se `mode` aplicável a este step:
   a. Critic LLM recebe: input do step + output proposto + hint estrutural ("revise issues; declare confidence")
   b. Output do critic em schema fixo:
      ```yaml
      critique:
        issues:
          - { severity: enum [info, warn, error]
            , description: string
            , confidence: float    # 0..1
            , suggestion: string }
        overall_confidence: float  # 0..1, sobre o output principal
      ```
3. Filtra issues com `confidence ≥ threshold`
4. Se há issues filtradas:
   - **Emite `critique:ask`** (modal pattern, UI.md §5.5) ao user **antes** de proceder
   - User pode: `[i]gnore`, `[r]edo with hint`, `[a]bort step`, `[w]hy?`
5. Audit: critique runs vão pra `failure_events` com `code: critique.warning_shown` ou `critique.skipped`

#### Onde **NÃO** roda

- Plan mode (já é validation; redundante)
- Tools read-only (`read_file`, `glob`, `grep`) em modo `on_writes`
- Compaction step (próprio compaction tem eval; redundante)
- Critic step (não recursivo)

#### Trade-offs honestos

| Pro | Con |
|---|---|
| Catches bugs do agente antes do user ver | 2x latência em steps cobertos |
| 2x custo só nos steps onde aplicável (mode=on_writes mitiga) | Custo extra mensurável |
| Aligns com "meça duas vezes" | False positives podem irritar (threshold ajustável) |
| Independente do modelo principal (pluggável) | Manutenção de prompt do critic |

#### Eval do critic

Eval específico em `evals/critique/`:
- Fixtures com bugs conhecidos no output principal — critic deve detectar
- Fixtures com output limpo — critic não pode inventar issues (false positive rate < 5%)
- Threshold tuning baseado em ROC curve

Sem eval, critic vira ruído (warnings constantes que user aprende a ignorar).

### 5.4.1 Memory governance detectors (per-project opt-out)

Os três detectores LLM-judge do memory subsystem (`verify_failed` em [`MEMORY.md`](./MEMORY.md) §11, `conflict_detected` em §11, `user_override_repeated` em §11) são **default ON** por default. Operator faz opt-out via `.agent/config.toml`:

```toml
# ~/.config/agent/config.toml ou .agent/config.toml
[memory]
verify_semantic_llm = false        # desliga S11 verify_failed (default true)
conflict_detect_llm = false        # desliga S13 conflict_detected (default true)
override_detect_llm = false        # desliga S3 user_override_repeated (default true)
```

**Precedência** (first-match wins):

1. **CLI flag** explicit — `--memory-verify-llm` / `--no-memory-verify-llm` (idem `--memory-conflict-llm` e `--memory-override-llm`). Session-only override; ignora config.
2. **Project config** — `<cwd>/.agent/config.toml [memory]`. Per-projeto, versionado pelo time.
3. **User config** — `~/.config/agent/config.toml [memory]`. Per-user, cross-project.
4. **Default ON** — hardcoded em `src/critique/config-loader.ts:DEFAULT_MEMORY_CONFIG`.

**Layers (2):** user + project. Sem enterprise layer ainda — mirror do `[critique]` block; spec amenda quando regulated environment surfacar. Snake_case canonical; camelCase aliases aceitos (mesma posture de `[critique]`).

**Slash:** `/memory governance enable | disable verify|conflict|override|all` escreve `.agent/config.toml [memory]`. `all` cobre os três detectores. Efeito vale a partir do próximo turn boundary (snapshot semantic).

**First-boot advisory:** quando OS TRÊS detectores resolvem ON via default (nenhum layer setou, nenhuma CLI flag, marker em `~/.local/share/forja/.governance-banner-shown` ausente), boot emite uma linha stderr `memory: governance LLM detectors enabled by default (verify=on, conflict=on, override=on). Disable: /memory governance disable verify|conflict|override|all`. Suppressed em `--json` mode, subagent context, e após primeira sessão (marker em `~/.local/share/forja/`).

---

## 6. Context Engine

> **Detalhamento operacional:** [`CONTEXT_TUNING.md`](./CONTEXT_TUNING.md) — system prompt architecture, layout + cache breakpoints, memory loading, tool palette, few-shot strategy, format choices, attention positioning, per-step shaping, goal re-injection mechanics, repo map injection, selective inclusion, per-workflow recipes. Esta seção é overview.
>
> **Driver de seleção:** [`RETRIEVAL.md`](./RETRIEVAL.md) decide **WHAT** entra no contexto dado um goal (pipeline `candidates → expansion → ranking → compression`); CONTEXT_TUNING decide **HOW** formatar o que já entrou. Sem retrieval declarado, "memória infinita"/RAG vira cargo cult ([`ANTI_PATTERNS.md §2.2`](./ANTI_PATTERNS.md)).

Estrutura do prompt **fixa, ordem importa, cache breakpoints conscientes**:

```
[system]            estável        ← cache breakpoint #1
[tool schemas]      estável        ← cache breakpoint #2
[project context]   pointer pra AGENTS.md (~50 tokens; body lazy via read_file)  ← cache breakpoint #3
[compacted history] resumo turns antigos
[recent turns]      últimos N na íntegra
[current turn]      mensagem + tool results pendentes
```

Prompt cache da Anthropic tem TTL de 5min. Layout fixo + breakpoints corretos cortam custo em 70%+. Layout solto desperdiça cache silenciosamente.

### Compaction

Gatilho: **70%** do context window, não 100%.

Estratégia em camadas:

1. **Tool results grandes** → trunca com pointer (`<truncated, re-read with tool X>`).
2. **Turns antigos** → resume preservando: goal original, decisões tomadas, arquivos tocados, erros encontrados.
3. **Nunca compacta** o turn atual nem os 3 últimos.
4. **Goal re-injection** — objetivo original sempre presente literal, nunca resumido.
5. **Hint manual** — `/compact <foco>` permite usuário dirigir o que preservar.

Compaction é uma chamada LLM separada — modelo configurado em `compaction.model`, **não vendor-locked**. Default por profile: `autonomous` usa modelo cheap-but-capable do mesmo provider (Haiku se Anthropic, gpt-4o-mini se OpenAI, etc); `orchestrated` usa o backend local; `hybrid` é declarado em config. Prompt versionado, **testada por eval**. Sem isso degrada silenciosamente.

Em profile `orchestrated`, compaction usa modelo do próprio backend (não Haiku) com prompt mais agressivo e schema fixo (`goal`, `decisions`, `files_touched`, `errors`).

**Compaction = retrieval re-query com budget menor.** Critério de "o que fica" delega ao [`RETRIEVAL.md §15.5`](./RETRIEVAL.md) — re-rank dos candidatos do contexto atual com `budget' < budget`; o que cai fora do top-K vira candidato a eviction efêmera ([`EVICTION.md §9`](./EVICTION.md)). Pinned items são gate absoluto ([`CONTEXT_TUNING.md §12.4`](./CONTEXT_TUNING.md)). Fallback determinístico (`drop_oldest`) preservado em [`ORCHESTRATION.md §4.6`](./ORCHESTRATION.md) quando retrieval indisponível.

### Repo Map (essencial em `orchestrated`, opcional em `autonomous`)

Modelo pequeno **não pode** fazer "grep storm". Repo map injetado no contexto base resolve 60% das buscas sem chamar tool.

Implementação: tree-sitter extrai símbolos (funções, classes, exports, imports) de cada arquivo, monta representação compacta (~2k tokens pra repo médio):

```
src/auth.ts:
  export function login(email: string, password: string): Promise<Session>
  export class AuthError extends Error
  internal: validateCredentials, hashPassword

src/queue.ts:
  export class JobQueue
    method enqueue(job: Job): Promise<JobId>
    method dequeue(): Promise<Job | null>
  internal: drainTimer, retryBackoff
```

Atualizado incrementalmente em `PostToolUse` quando `write_file`/`edit_file` afeta arquivo.

Em profile `autonomous`, repo map é injetado sob demanda (tool `repo_map`) — frontier não precisa por default. Em `orchestrated`, vai no system context base, sempre.

---

## 7. Tool System

```ts
interface Tool<I, O> {
  name: string
  description: string         // o modelo lê isso, capricha
  inputSchema: JSONSchema     // validado em runtime
  outputSchema?: JSONSchema   // opcional, ajuda eval
  policy: ToolPolicy
  execute(args: I, ctx: ToolContext): Promise<O>
  preview?(args: I): string   // pra confirmação humana
  cost?(args: I): number      // pra budget
  writes?: boolean            // dispara checkpoint
}
```

### 7.1 Tools v1 (mínimo viável, máximo útil)

**Filesystem & busca**
- `read_file` — com offset/limit
- `write_file` — com diff preview
- `edit_file` — string replacement (não regex; menos alucinação)
- `glob` — file pattern
- `grep` — ripgrep wrapper

**Execução**
- `bash` — com timeout, abort, env limpo, sandbox opcional
- `bash_background` — spawna processo, retorna `process_id`
- `bash_output` — lê stdout/stderr novo desde último read
- `bash_kill` — SIGTERM com fallback SIGKILL

**Monitoring & wait**
- `wait_for(condition, options)` — bloqueia até condition met OR timeout; **zero LLM calls durante o wait**
- `monitor(condition, options)` — streaming events durante observação; LLM só ao fim

**Rede**
- `web_fetch` — com cache e deny_hosts

**Coordenação**
- `task` — spawn subagent (alias `task_sync`)
- `task_async` — spawn subagent paralelo, retorna handle
- `task_await` — coleta output de subagent async
- `todo_write` — task tracking interno (visível ao usuário)

**Memória (cross-session)**
- `memory_read(name, scope?)` — lê conteúdo lazy
- `memory_write(name, scope, type, body, expires?)` — propõe write; UI confirma
- `memory_search(query, scope?)` — grep nas memórias (não vector)
- `memory_list(scope?)` — lista do índice sem ler conteúdo

Detalhes do subsistema em [`MEMORY.md`](./MEMORY.md). Markdown-based, escopo isolado (user/project), confirmação humana obrigatória em writes, audit log em `memory_events`.

**Não tem `list_dir`** — `glob "*"` resolve.
**Não tem retrieval semântico v1** — grep+glob batem em código.

### 7.2 MCP

> **Autoridade detalhada:** [`MCP.md`](./MCP.md) — lifecycle, transport, manifest, namespacing, sandbox, budget, slash commands, observabilidade. Esta seção é overview.

Cliente MCP nativo é a **única superfície declarada de extensão** do tool catalog v1 (`CONTRACTS.md §2.6.7`). Tools de servidores MCP aparecem no registry como `mcp:<server>:<tool>` — namespacing obrigatório, sem colisão com canônicos. Mesmas regras de permissão se aplicam. Servidores entram pelo trust prompt (§9.4) com hash do manifest gravado em `AUDIT.md §1.5`; mudança de manifest força re-trust.

Transport: stdio (default), SSE, e streamable HTTP. Conexão é **lazy** — server só conecta quando modelo chama uma tool. Per-server budget e sandbox em `MCP.md §5, §2.3`. State machine completa em `STATE_MACHINE.md §6.5`. Contrato formal em `CONTRACTS.md §11`.

### 7.3 Background processes

Para processos longos (`npm run dev`, `pytest --watch`, builds), tools dedicadas:

- `bash_background(cmd, label, max_log_bytes?)` — spawna, retorna `process_id`, não bloqueia
- `bash_output(process_id, since?)` — incremental, com cursor
- `bash_kill(process_id)` — graceful → forced

Estado dos processos: tabela `background_processes`. Persistido entre steps. Limpo no fim da sessão (ou via `/bg cleanup`).

UI: status line mostra tray de background processes (`bg N` com counts; detalhes via `/bg list`). Ver UI.md §4.4.

**Per-stream on-disk cap (slice 153):** stdout/stderr de um bg process são drenados para `<log_dir>/<id>.{stdout,stderr}.log` via pipe-+-drainer próprio (não `Bun.file(path)` direct redirection). Cada stream tem um cap configurável (`max_log_bytes`, default 50 MB). Quando o file alcançaria o cap, o drainer trunca a CABEÇA do file (os bytes mais antigos) e retém a CAUDA (mais recente) — preserve o estado atual do processo, que é o que o LLM lê primeiro.

Cursor semantics são **absolutos** (bytes-since-spawn), não file-offset. Coluna `*_bytes_dropped` (migration 043) registra quantos bytes foram descartados do head. `bash_output` mapeia `since=N` para o file-offset corrente via `file_offset = max(0, N - bytes_dropped)`. Um `since` value de uma resposta anterior continua válido depois de uma truncate.

`max_log_bytes`:
- Default: 50 MB por stream
- Mínimo: 1024 bytes (caps sub-1KB são bug do caller; refuse no spawn)
- Opt-out: `Number.POSITIVE_INFINITY` desliga o cap (file cresce sem limite — workflows que precisam log completo retido).

### 7.3.1 Wait & Monitor primitives

Background processes precisam de **coordenação eficiente** sem polling em loop (custo LLM em cada step). Duas tools dedicadas:

#### `wait_for` (synchronous, blocking)

```ts
wait_for(condition: WaitCondition, options: {
  timeout_ms: number,
  poll_interval_ms?: number             // default 500ms para non-streaming sources
}): WaitResult

type WaitCondition =
  | { kind: 'process_output'; process_id: string; pattern: string | regex }
  | { kind: 'process_exit'; process_id: string }
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_change'; path: string }                  // mtime change
  | { kind: 'port_open'; host: string; port: number }
  | { kind: 'http_response'; url: string; status?: number }
  | { kind: 'sleep'; duration_ms: number }                  // timed sleep
  | { kind: 'all_of'; conditions: WaitCondition[] }         // AND, todas precisam matchar
  | { kind: 'any_of'; conditions: WaitCondition[] }         // OR, primeira que match retorna

interface WaitResult {
  matched: boolean
  condition_met: 'timeout' | 'process_output' | 'process_exit' | 'file_exists' | ...
  elapsed_ms: number
  payload?: any                                              // match groups, file content, http body, etc
}
```

**Comportamento:**
- Tool **bloqueia** até condition met OR timeout
- **LLM não é chamado** durante o wait — zero LLM cost; só wall-clock
- Wall-clock conta pra `maxWallClockMs`
- Cancellable via Ctrl+C / Esc Esc (AbortSignal cascateia)
- `process_output`: subscribe ao stream do bg process; match pattern incremental
- `file_*`: filesystem watch (chokidar / `fs.watch`)
- `port_open`: TCP probe com poll
- `http_response`: HEAD/GET com poll
- `sleep`: `setTimeout`
- Composição via `all_of`/`any_of` (race conditions possíveis em `any_of`)

**Exemplo:**

```
[step 3] tool: bash_background "npm run dev" → pid 12345
[step 4] tool: wait_for { kind: process_output, process_id: 12345, pattern: "ready on port" }, timeout=60s
  ⏳ waiting... (12s)
  ✓ matched at 12.3s · payload: { match: "ready on port 3000" }
[step 5] tool: bash "curl http://localhost:3000/api" → ...
```

Sem `wait_for`: 4-5 steps de polling em loop, ~$0.40 em LLM calls. Com: 3 steps, ~$0.10.

#### `monitor` (streaming observation)

```ts
monitor(condition: MonitorCondition, options: {
  duration_ms?: number,                  // max duration; null = until cancelled
  max_events?: number                    // stop após N eventos
}): MonitorResult

type MonitorCondition =
  | { kind: 'process_output_lines'; process_id: string }
  | { kind: 'process_output_pattern'; process_id: string; pattern: regex }
  | { kind: 'file_changes'; path: string | glob }
```

**Comportamento:**
- Tool **streama eventos** durante a duração
- Cada evento aparece como linha viva (via tool card streaming) ou hook `Notification`
- LLM **não é chamado** entre eventos — apenas UI atualiza
- LLM roda no fim (max_events hit, duration end, ou cancellation)
- Útil em: watch builds, log tailing, file watching

**Exemplo:**

```
[step 3] tool: bash_background "npm run watch" → pid 99999
[step 4] tool: monitor { kind: process_output_pattern, process_id: 99999, pattern: /WARN|ERROR/ }, max_events=10
  📡 monitoring... (max 10 events)
  → WARN: deprecated import in src/foo.ts:12
  → WARN: unused variable in src/bar.ts:45
  → ERROR: type mismatch in src/baz.ts:88
  ...
  ✓ 10 events captured
[step 5] modelo decide o que fazer com warnings
```

#### Hibernation (deferred v2)

V1: synchronous wait (agent live durante o wait). Pra waits longos (hours), agent ocupa process.

V2 considerar: agent process exit; daemon monitora condition; hook `Notification` dispara em wakeup; `agent --resume` reataca. Complexidade de daemon + multi-instance issues fica pra quando demanda real chegar.

### 7.4 TodoList

Tool interna `todo_write(items)` que o agente usa pra rastrear sub-tarefas durante execução longa. Cada item: `{ content, status: pending|in_progress|done, activeForm }`.

Renderizada como checklist live no TUI. **Não persiste** entre sessões — é estado de trabalho, não memória.

Por que importa: dá visibilidade do plano implícito sem forçar planner formal. Modelo escolhe usar ou não. Eval premia uso em tarefas de 5+ steps.

### 7.5 Validator Framework

Cidadão de primeira classe em profile `orchestrated`, usado opcionalmente em `autonomous` (ex: hook `PostToolUse`).

```ts
interface Validator<O> {
  name: string
  validate(output: O, ctx: StepContext): ValidationResult
}

type ValidationResult =
  | { ok: true; value: O }
  | { ok: false; error: string; retry_hint?: string; fatal?: boolean }
```

**Built-ins:**
- `JSONSchemaValidator` — schema enforced
- `FileExistsValidator` — paths citados existem no FS
- `LineExistsValidator` — `file:line` é válido
- `ASTValidator` — código proposto compila/parseia (tree-sitter)
- `ContainsValidator` — output contém string/regex
- `NotContainsValidator` — output **não** contém (ex: detectar "TODO", placeholders)
- `ToolCallShapeValidator` — args batem com schema da tool
- `DiffApplicabilityValidator` — `old_string` ainda existe no arquivo

**Fluxo:**
1. Step LLM produz output
2. Validators rodam em ordem (rápidos primeiro, baratos antes de caros)
3. Falha → `retry_hint` re-injetado no prompt, retry (≤2)
4. Falha persistente → escala (fallback model em hybrid, ou aborta)

**Diferença vs hooks:** hooks são extensão de usuário, validators são contrato do step. Validator é parte do DAG; hook é extensão lateral.

**Trade-off honesto:** validators custam manutenção. Não validar é mais simples mas modelo pequeno produz lixo. Não dá pra ter os dois.

---

## 8. Permission Engine

Política como **dado**, versionada:

```yaml
# permissions.yaml
defaults:
  mode: strict   # strict | acceptEdits | bypass

tools:
  bash:
    allow:
      - "git status"
      - "git diff *"
      - "ls *"
      - "rg *"
      - "cat *"
    confirm:
      - "git push *"
      - "rm *"
      - "npm install *"
    deny:
      - "rm -rf /*"
      - "sudo *"
      - "curl * | sh"
      - "* > /dev/sd*"

  write_file:
    allow_paths: ["./src/**", "./tests/**", "./docs/**"]
    deny_paths: ["**/.env*", "**/secrets/**", "/**", "~/**"]

  web_fetch:
    deny_hosts: ["localhost", "127.0.0.1", "169.254.*", "10.*"]
    trusted_hosts: ["github.com", "raw.githubusercontent.com"]
```

Matching é **prefix + glob**, não regex. Regex em política é pé na bola.

`trusted_hosts` (additive sobre `DEFAULT_TRUSTED_HOSTS` em `src/permissions/risk-score.ts`) reduz o risk-score de fetches pra esses hosts — útil pra time que tem CDN interno, GitHub Enterprise, ou outros endpoints conhecidos-bons. NÃO é um allowlist: `deny_hosts` continua tendo precedência (host trusted que também aparece em deny ainda é negado). A lista hardcoded cobre o consensus público (`github.com`, `npmjs.com`, etc.); o per-projeto trusted_hosts é pra a hidden surface de cada repo.

Modos:
- `strict` (default) — confirma o que é confirmável, nega o resto.
- `acceptEdits` — aceita edits sem confirmação, ainda nega o que é deny.
- `bypass` — só com flag explícita `--dangerous` + warning vermelho.

Hierarquia: **enterprise** (`/etc/agent/`) → **user** (`~/.config/agent/`) → **project** (`./.agent/`) → **session** (flag). Enterprise pode marcar regras como `locked` (impede override).

Cada decisão vai pra tabela `approvals` (auditoria).

**Bootstrap path.** A engine não inventa allow rules — sem `.agent/permissions.yaml` o projeto roda em strict default-deny e toda gated tool retorna `kind: 'deny'`. O operador escreve o arquivo manualmente OU roda `agent init` (§2.1), que gera um baseline editável: strict mode, allow whitelist conservador (`git status`, `ls`, `rg`), confirm pra ações observáveis (`git push`, `rm`, `*install`), deny pra padrões catastróficos (`rm -rf /*`, `sudo`, `curl|sh`), e protections de path/host óbvias (`.env*`, `.git/`, loopback). O REPL detecta a ausência do arquivo no boot e emite uma linha vermelha apontando pra `agent init` / `/perms` (§17).

Além do `permissions.yaml`, `agent init` scaffolda no mesmo passo três outros artefatos no `.agent/`: o `.gitignore` (template em [`MEMORY.md`](./MEMORY.md) §2.5), o `config.toml` documentando o schema com todas as chaves comentadas (§2.1.1), e os 10 playbooks canônicos sob `agents/` (lista em [`PLAYBOOKS.md`](./PLAYBOOKS.md)). Cada passo é idempotente — re-rodar `init` em repo já parcialmente scaffoldado preenche só o que falta sem tocar nas edições do operador. `--only=csv` restringe o scaffold a um subconjunto entre `permissions`, `gitignore`, `config`, `playbooks`; `--force` (ou `--force=csv`) sobrescreve. Note que `.gitignore` **não** é aceito em `--force` — é operator-owned após criação (§2.5 do `MEMORY.md`).

---

## 9. Trust & Safety

Vetores de ataque óbvios:

- `AGENTS.md` malicioso em repo terceiro → prompt injection
- MCP server hostil → tool envenenada
- Scripts em `~/.config/agent/commands/` adulterados
- Output de `bash` com sequências ANSI maliciosas
- Hook substituído entre sessões

### 9.1 Trust prompt

Primeira vez que o agente abre num diretório novo:

```
⚠ Diretório não-confiável detectado: /path/to/repo

Este é seu primeiro acesso. O agente vai ler:
  - AGENTS.md                    (12 KB)
  - .agent/config.toml           (não existe)
  - .agent/permissions.yaml      (8 KB)
  - .agent/playbooks/            (3 arquivos)
  - .agent/memory/shared/        (5 entradas)

Continuar? [y/N/inspecionar]
```

Diretórios confiados ficam em `~/.config/agent/trusted_dirs` com **hash agregado** do conteúdo crítico:
- `AGENTS.md`
- `.agent/config.toml`
- `.agent/permissions.yaml`
- `.agent/hooks.toml`
- `.agent/memory/shared/**` (todos arquivos)
- `.agent/playbooks/**`
- `.agent/agents/**`
- `.agent/orchestrators/**`

**Re-prompt** se hash agregado mudar — clone, pull, ou modificação local em qualquer artefato versionado dispara nova confirmação. Mudança em `.agent/memory/local/` (per-user) **não** dispara re-trust.

Em modo `--json` non-interactive, sem trust prompt: erro fatal se diretório não confiado, exit 3.

### 9.2 Sandbox de `bash`

Policy YAML é primeira linha. Segunda linha é sandbox **real**:

- **Linux**: `bwrap` (bubblewrap) — namespace mount, sem rede em modo strict, `/etc` read-only.
- **macOS**: `sandbox-exec` com profile mínimo.
- **Fallback**: `bash` direto + warning explícito se sandbox indisponível.

Sandbox é opcional no v1 (flag `--sandbox`), default no v2.

### 9.3 Output sanitization

Output de tools que vai pro contexto passa por filtro:
- Strip de sequências CSI maliciosas (`\x1b[...]`) — preserva apenas SGR seguro
- Truncate de output > 100KB com pointer
- Detecção heurística de injection ("ignore previous instructions", "you are now") — não bloqueia, mas marca o tool result com flag visível ao modelo e usuário

### 9.4 MCP server trust

Cada servidor MCP novo passa pelo trust prompt antes da primeira chamada. Tools de MCP não-confiável ficam invisíveis ao modelo. Hash do manifest do servidor armazenado pra detectar troca.

---

## 10. Hooks

Mecanismo pra usuário estender comportamento **sem tocar no código**. Hooks são shell commands disparados em eventos do harness.

### 10.1 Eventos

| Evento | Quando dispara | Pode bloquear? |
|---|---|---|
| `SessionStart` | Início de sessão | não |
| `UserPromptSubmit` | Antes do prompt entrar no contexto | sim (rejeita prompt) |
| `PreToolUse` | Antes de executar tool | sim (nega tool) |
| `PostToolUse` | Após execução (sucesso OU erro — paralelo a PostToolUseFailure) | não |
| `PostToolUseFailure` | Após execução **com falha** apenas — dedicado pra alerts/retry/log (slice 181) | não |
| `PreCompact` | Antes de compaction | sim (cancela) |
| `Notification` | Permission prompt mostrado | não |
| `PreCheckpoint` | Antes de snapshot | não |
| `MemoryWrite` | Antes de gravar nova memória | sim (bloqueia write) |
| `Stop` | Fim de sessão | não |

### 10.2 Configuração

```toml
# ~/.config/agent/hooks.toml
[[hooks]]
event = "PostToolUse"
matcher = { tool = "write_file" }
command = "prettier --write {{tool.input.path}}"

[[hooks]]
event = "PreToolUse"
matcher = { tool = "bash" }
command = "~/.config/agent/hooks/audit.sh"
# stdin: JSON do evento; exit 0 = allow, 1 = block, 2 = block com mensagem

[[hooks]]
event = "Stop"
command = "notify-send 'Agente terminou: ${cost_usd}'"
```

### 10.3 Contrato

- **Input**: JSON do evento via stdin (estruturado, versionado: `{ schema: "v1", event, ... }`).
- **Output**: stdout vira mensagem opcional; exit code controla decisão. Exit 0 + stdout-as-JSON desbloqueia surface estruturada (`additionalContext`/`updatedInput`/`suppressOutput` — slice 181).
- **Timeout**: 5s default. Hook lento é hook morto (não trava o harness).
- **Logging**: cada execução grava em tabela `hook_runs` (auditoria).
- **Hierarquia**: hooks de enterprise rodam primeiro, podem ser `locked`.

### 10.3.1 JSON output (slice 181)

Hook que exit 0 e cujo stdout começa com `{` é parseado como JSON. Campos reconhecidos:

| Campo | Tipo | Efeito |
|---|---|---|
| `additionalContext` | string | Concatenado em ordem de execução através do chain; o consumidor (harness invoke-tool) injeta como um marker `[forja:hook-context event=…]` no `tool_result.content` que vai pro modelo. Cap herdado do stdout 4KB. |
| `updatedInput` | object | Apenas em `PreToolUse`. Substitui `args` ANTES de execução. Last-wins quando múltiplos hooks emitem. Audit row armazena os args ORIGINAIS (`args_hash` lock pre-PreToolUse), tool body recebe os mutados. |
| `suppressOutput` | boolean | Hide hook stdout no debug log. Audit row ainda registra. |

Stdout não-JSON ou JSON malformado: hook é tratado como allow plain — o caminho atual de "stdout vira string opcional" preservado. Operator que precisa de mais de 4KB de additionalContext divide em hooks múltiplos (chain concatena).

### 10.3.2 Per-handler `if` filter (slice 181)

Cada `[[hooks]]` aceita um campo `if` com sintaxe permission-rule:

```toml
[[hooks]]
event = "PreToolUse"
matcher = { tool = "bash" }
if = "Bash(rm *)"
command = "./check-rm.sh"
```

Semântica:

- **Bash(<glob>)** — match contra `args.command`, subcommand-aware via `;`/`&&`/`||` splits. Sinônimos: `Bash` == `bash`.
- **Edit(<glob>)**, **Write(<glob>)**, **Read(<glob>)** — match contra `args.file_path`/`args.path`. Two-shot: full path primeiro, depois basename quando o pattern não tem `/` (paridade com `Edit(*.ts)` matching `src/main.ts`). Sinônimos: `Edit` == `edit_file`, etc.
- Demais tools — fail-open (filtro não-suportado roda o hook).
- Eventos não-tool: hook com `if` é skipped (filter unsatisfiable).
- Pattern malformado: fail-open (operator intent era filtrar, não negar).

### 10.3.3 `disableAllHooks` kill switch (slice 181)

Flag em policy/settings; quando true o dispatcher retorna chain vazia imediatamente. Útil pra debug. Managed settings podem fixar em enterprise layer; user/project não desfazem.

### 10.4 Casos de uso reais

- Auto-format após edit (`prettier`, `black`, `gofmt`)
- Auto-commit no fim de sessão com mensagem gerada
- Validar que `write_file` não toca arquivo gerado (`generated/`, `dist/`)
- Notificar Slack/desktop em `Notification`
- Bloquear `bash` que invoque ferramenta proibida pela equipe
- Injetar contexto extra em `UserPromptSubmit` (linter output, status do CI)

Hooks transformam o agente de produto fechado em **plataforma**. Sem isso, qualquer customização vira fork.

---

## 11. Subagents

Subagent = Agent Harness com:

- contexto **isolado** (não vê history do pai)
- prompt customizado por tipo (`explore`, `plan`, `review`)
- budget próprio (geralmente menor)
- output **estruturado** de volta ao pai (texto, não history)

Pai vê: input enviado + output final. **Não vê** os steps intermediários — esse é o ponto. Protege contexto do pai de poluição.

Implementação: mesmo binário, processo separado, comunicação via SQLite (write-only do filho, read-only do pai). Permite cancel propagation e replay.

### 11.1 Definição declarativa

`~/.config/agent/agents/*.md`:

```markdown
---
name: explore
description: Busca arquivos e responde perguntas sobre o codebase
tools: [read_file, grep, glob]
budget: { max_steps: 20, max_cost_usd: 0.50 }
---

Você é um agente de exploração. Sua única tarefa é responder
a pergunta do usuário lendo o codebase. Não edite arquivos.
Retorne resposta concisa com paths:linhas referenciados.
```

Subagents são pluggáveis sem recompilar.

### 11.2 Worktree isolation (opt-in)

Para subagents que **editam código**, opção de criar `git worktree` dedicado:

```yaml
---
name: refactor
isolation: worktree   # cria branch + worktree temporário
budget: { max_steps: 30, max_cost_usd: 1.50 }
---
```

Fluxo:
1. `git worktree add /tmp/agent-<id> -b agent/refactor-<id>`
2. Subagent roda no worktree, `cwd` apontado pra ele
3. Output do subagent inclui diff/branch
4. Pai decide: merge, descarta, ou abre PR
5. Cleanup automático se subagent não fez mudança

Sem worktree: subagents compartilham filesystem do pai, com risco de race em edits paralelos. Em modo `task` paralelo, worktree vira default.

### 11.3 Playbooks (subagents especializados)

Playbook = subagent com **constraints + output schema + tools restritas**, otimizado para um workflow específico (review, audit, debug). Não é "personalidade" nem "step-by-step scaffold" — é trilho.

Diferenças vs subagent genérico:

| Aspecto | Subagent genérico | Playbook |
|---|---|---|
| Tools | whitelist | whitelist **+ restrictions por tool** (ex: `bash` só comandos read-only) |
| Output | livre | **schema obrigatório** com `summary` + `assumptions` + `not_checked` |
| Persona | livre | proibida — só constraints negativas e schema |
| Eval | opcional | **obrigatório** antes de virar `slash:` ativo |
| References | livre | declaradas no frontmatter, lidas sob demanda (sem embed) |

Definidos em `~/.config/agent/playbooks/*.md`. Disparados por slash command (`/review`, `/audit`, `/debug`, `/refactor`, `/explain`, `/threat-model`, `/perf`, `/git-hygiene`) ou por `task(playbook: <name>)` em código de outro agente.

Templates iniciais e princípios de design em [`PLAYBOOKS.md`](./PLAYBOOKS.md). **Oito** playbooks na v1: `code-review`, `security-audit`, `debug`, `refactor`, `explain`, `threat-model`, `perf-investigate`, `git-hygiene`. Acima do teto recomendado de 6 — decisão deliberada documentada em `PLAYBOOKS.md §12`; revisão eval-driven gatilho se modelo confunde seleção > 5%.

---

## 12. Checkpoints & Rollback

Antes de qualquer step que **modifique filesystem**, snapshot incremental.

### 12.1 Mecanismo

- **Implementação**: `git stash` interno em ref dedicado (`refs/agent/checkpoints/<session>`), invisível ao log normal.
- **Fallback (não-git)**: copy-on-write via `cp --reflink=auto` em filesystems que suportam (btrfs, xfs, apfs).
- **Granularidade**: um checkpoint por step com tool de escrita, não por tool individual.
- **Trigger**: harness chama `CheckpointManager.snapshot()` antes de qualquer tool com `writes: true`.

### 12.2 Comandos

- `/undo` — reverte último step (restaura checkpoint anterior)
- `/checkpoint list` — lista pontos restauráveis da sessão
- `/checkpoint restore <id>` — volta pra ponto específico
- `/diff <checkpoint>` — diff entre estado atual e checkpoint

### 12.3 Limites (honestos)

- Apenas filesystem dentro de `cwd` por default. Edição em `~/.config` ou `/tmp` não é checkpointed.
- Não substitui git. Sessão longa sem commit = stash gigante. Hook de auto-commit recomendado.
- **Side effects de `bash` (DB, network, processos) NÃO são revertidos.** Aviso explícito antes de `/undo` se step incluiu `bash`. Esse é o limite real do mecanismo — o usuário precisa saber.

### 12.4 Integração com plan mode

Plan mode + checkpoint = workflow seguro pra refactor grande:
1. `/plan` → modelo propõe N steps
2. Usuário aprova → modo `run`
3. Cada step gera checkpoint
4. Em qualquer ponto, `/undo` ou `/checkpoint restore`
5. Final: review do diff total via `/diff <primeiro checkpoint>`

---

## 13. Modelo de dados

```sql
sessions(
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  model TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,       -- running | done | interrupted | exhausted | error
  total_cost_usd REAL DEFAULT 0
);

messages(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_id TEXT REFERENCES messages(id),
  role TEXT NOT NULL,         -- user | assistant | tool
  content JSONB NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cached_tokens INTEGER,
  created_at INTEGER NOT NULL
);

tool_calls(
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  tool_name TEXT NOT NULL,
  input JSONB NOT NULL,
  output JSONB,
  status TEXT NOT NULL,       -- pending | running | done | error | denied
  duration_ms INTEGER,
  error TEXT
);

approvals(
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  decision TEXT NOT NULL,     -- allow | deny | confirm_yes | confirm_no
  decided_by TEXT NOT NULL,   -- policy | user | hook
  decided_at INTEGER NOT NULL
);

checkpoints(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,      -- messages.id da assistant turn que disparou o snapshot
  git_ref TEXT NOT NULL,      -- commit SHA do snapshot (ver CHECKPOINTS.md §2.4)
  created_at INTEGER NOT NULL,
  had_bash INTEGER NOT NULL DEFAULT 0
                                CHECK (had_bash IN (0, 1))
);
-- Forma resolvida em CHECKPOINTS.md §2.4. As colunas `kind`,
-- `files_changed` e `size_bytes` da v0 não são mais necessárias:
-- v1 é git-only (kind sempre 'git'), e os contadores de tamanho
-- viraram telemetria opcional (PERFORMANCE.md), não dado de
-- audit. `had_bash` substitui essa cobertura — drives o warning
-- no /undo quando o step também rodou bash.

hook_runs(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  blocked BOOLEAN,
  message TEXT,
  created_at INTEGER NOT NULL
);

background_processes(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  label TEXT,
  cmd TEXT NOT NULL,
  pid INTEGER,
  status TEXT,                -- running | exited | killed
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER
);

memory_events(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,        -- user | project
  action TEXT NOT NULL,       -- proposed | created | edited | deleted | read | refused
  memory_name TEXT NOT NULL,
  source TEXT NOT NULL,       -- user_explicit | inferred | imported
  session_id TEXT,
  cwd TEXT,
  created_at INTEGER NOT NULL,
  details JSONB               -- diff, motivo de refuse, hash do source
);
-- Conteúdo das memórias fica em arquivo (~/.config/agent/memory/, ./.agent/memory/),
-- não no SQLite. Tabela é só audit trail.

recap_runs(
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,   -- session_current | session_specific | day | range | pre_compact
  session_ids TEXT NOT NULL,  -- JSON array
  renderer TEXT NOT NULL,     -- human | pr | changelog | slack | terse | json
  used_llm BOOLEAN NOT NULL,
  output_path TEXT,           -- se --out usado
  created_at INTEGER NOT NULL
);

recap_cache(
  scope_hash TEXT PRIMARY KEY, -- hash do scope_kind + session_ids + renderer
  renderer TEXT NOT NULL,
  output TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL  -- TTL 1h default
);

traces(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span TEXT,
  name TEXT NOT NULL,
  attrs JSONB,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER
);

artifacts(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,         -- snapshot | diff | output
  path_or_blob TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
```

Índices só onde dói:
- `messages(session_id, created_at)`
- `tool_calls(tool_name, status)`
- `hook_runs(session_id, event)`
- `sessions(started_at DESC)` — list-sessions ordenada por data
- `sessions(cwd, started_at DESC)` — list-sessions filtrado por projeto
- `sessions(status, started_at DESC)` — filter por status

**Sem ORM.** SQL cru com tipos. ORM em projeto pequeno é imposto sem benefício.

---

## 14. Provider Layer

```ts
interface Provider {
  id: string
  generate(req: GenerateRequest): AsyncIterable<StreamEvent>
  generateConstrained(req: ConstrainedRequest): Promise<string>
  countTokens(messages: Message[]): Promise<number>
  capabilities: ProviderCapabilities
}

interface ProviderCapabilities {
  tools: boolean              // tool calling nativo
  cache: boolean              // prompt cache
  vision: boolean             // image input
  constrained: ConstrainedKind | false   // gbnf | json_mode | tools | regex
  context_window: number
  max_tools_per_step?: number // recomendação (modelo pequeno: ~3)
}
```

**Provider-pluggable, não provider-parity.** Adapters são intercambiáveis no nível da API; qualidade, custo, e features são heterogêneos e ficam **declarados**, não escondidos. Sem vendor primary hardcoded — defaults vêm da config do usuário, recomendações por workflow vêm de evidência empírica em eval (ver [`PROVIDERS.md`](./PROVIDERS.md) §4 e §7).

Cada provider tem quirks reais (formatos de tool calling diferentes, semantics de cache distintas, streaming protocols variados, context windows ordens de magnitude diferentes). O `Provider` interface é **honesto sobre o que cada um faz**, não finge paridade. Lowest-common-denominator entrega mediocre; declarar heterogeneidade entrega decisão informada.

Em profile `orchestrated`, providers locais (Ollama, llama.cpp) são first-class por design — eles justificam o profile. Em `autonomous`, qualquer provider com `tools: 'native'` e `context_window` adequado serve; defaults dependem da config do usuário.

### 14.1 Constrained generation backend

Em profile `orchestrated`, validators precisam saber que o output vai chegar com schema. Constrained generation força isso no nível de geração, não no nível de validação.

| Provider | Mecanismo |
|---|---|
| Anthropic | tool calling (já é constrained no servidor) |
| OpenAI | structured outputs / function calling |
| Ollama | `format: "json"` ou JSON Schema (versões recentes) |
| llama.cpp | GBNF grammar (mais flexível e robusto) |
| vLLM | guided generation |

Para um nó `llm` do DAG com `output_schema`, o backend escolhe o mecanismo mais forte disponível. Se nenhum: retry baseado em parse + validador. Mas `force_constrained: true` no nó faz falha-imediata se backend não suporta — evita silent degradation.

#### Pipeline canônico

Pipeline `output_schema` → output validado, ordenado por força:

```
output_schema (declared)
  ↓
Step 1: Schema → backend grammar
  - GBNF (llama.cpp): JSON Schema → GBNF translator (built-in lib)
  - JSON Schema (OpenAI structured outputs): direct
  - tools (Anthropic, OpenAI tools native): converted to tool definition
  - JSON mode (Ollama): hint via prompt (modelo respeita ~90-95%)
  - regex/parse-only (last resort): no enforcement em runtime
  ↓
Step 2: Generation com enforcement
  - GBNF: rejection sampling em token-level (100% schema adherence)
  - structured outputs: server-side enforcement (100%)
  - tools native: 100% schema correto (formato fixo)
  - JSON mode: best-effort; parse-and-retry pós-generation
  ↓
Step 3: Parse output
  - Extract structured payload (JSON / tool_use args)
  - Strict JSON parse (fail = invalid)
  ↓
Step 4: Schema validate
  - validators[] em ordem (fast first)
  - Falha → retry com hint específico OR fallback
  ↓
Step 5: (validate ok) → emit pra step
```

#### Fallback chain

Quando `force_constrained: false` (default) e backend mais forte falha:

```
tools native      ← preferred (Anthropic, OpenAI)
   ↓ falha (raríssimo; bug do provider)
GBNF              ← se llama.cpp disponível
   ↓ falha (raro)
JSON mode + retry ← Ollama; até 2 retries com hint
   ↓ falha persistente
adapter regex     ← LOCAL_MODELS §3 pattern XML-style
   ↓ falha persistente
fail              ← step.error = `tool.constrained.exhausted`
```

`force_constrained: true`: aborta no primeiro fail; sem fallback. Útil em workflows de alta-criticality (security audit, refactor).

### 14.2 Model Registry

Capabilities de cada modelo declaradas em arquivo, usadas para auto-selecionar profile e prompt template.

```toml
# ~/.config/agent/models.toml
[models."anthropic/claude-opus-4-7"]
profile_default = "autonomous"
context_window = 200000
supports_tools = true
supports_caching = true
constrained = "tools"
recommended_max_tools_per_step = 12

[models."ollama/qwen2.5-coder:14b"]
profile_default = "orchestrated"
context_window = 32768
supports_tools = false
constrained = "gbnf"
recommended_max_tools_per_step = 3
prompt_template = "qwen"
notes = "Bom em code completion, fraco em multi-hop reasoning"

[models."ollama/llama3.1:8b"]
profile_default = "orchestrated"
context_window = 8192
supports_tools = false
constrained = "json_mode"
recommended_max_tools_per_step = 2
prompt_template = "llama3"
notes = "Context curto; agressivo em compaction"
```

Auto-seleciona profile baseado em capability. Override via flag.

### 14.3 Prompt templates por modelo

Modelos diferentes respondem a estilos diferentes. Template engine (Jinja-like) seleciona variante por `prompt_template`:

```
prompts/
  edit_file/
    default.j2          # genérico
    claude.j2           # zero-shot, conciso
    llama3.j2           # 2-3 few-shots, formato XML que llama gosta
    qwen.j2             # few-shots em estilo chat
    deepseek-coder.j2   # FIM-style quando aplicável
```

Sem isso, modelo pequeno chuta sintaxe e você vira mantenedor de wrappers.

### 14.4 Profile híbrido (custo-otimizado)

Caso de uso real: cobrir 80% do trabalho com local barato, escalar pra frontier no 20% difícil.

```toml
[profile.hybrid]
planner = "anthropic/claude-haiku-4-5"     # decompõe em DAG (barato)
executor = "ollama/qwen2.5-coder:14b"      # roda steps simples (free)
validator = "deterministic"                 # AST/schema (zero LLM)
fallback = "anthropic/claude-sonnet-4-6"   # escala em 2 falhas consecutivas

[profile.hybrid.routing]
on_validator_failure_count: 2 = "fallback"
on_step_type:
  refactor_complex = "fallback"
  rename = "executor"
```

Roteamento por tipo de step e por falha — não por sentimento.

---

## 15. Telemetry & Replay

Cada step emite span OTEL com:

- `model.input_tokens`, `model.output_tokens`, `model.cached_tokens`
- `tool.name`, `tool.duration_ms`, `tool.status`
- `cost.usd`
- `compaction.triggered`
- `checkpoint.created`
- `hook.fired`, `hook.blocked`

Local: NDJSON em `~/.local/share/agent/traces/<session>.ndjson`.
Opt-in export pra OTEL collector via env var (`OTEL_EXPORTER_OTLP_ENDPOINT`).

**Replay**: dado um `session_id`, reconstrói exatamente o contexto de qualquer step e re-executa. Essencial pra debug e pra eval. Replay em modo `--no-tools` simula sem efeitos colaterais.

---

## 16. Eval Harness

Sem eval, nada disso importa.

```yaml
# evals/refactor_basic.yaml
name: "extrai função pura"
setup:
  fixture: fixtures/messy_module
prompt: "extraia a lógica de validação em uma função pura"
expect:
  - tool_called: edit_file
  - file_contains:
      path: src/validate.ts
      pattern: "export function validate"
  - tests_pass: true
  - todo_used: true        # premia uso de todo_write
budget:
  max_steps: 15
  max_cost_usd: 0.50
```

Roda em CI. Comparação contra **golden traces** versionados. Mudou prompt do system? Roda eval. Regrediu? PR bloqueado.

Datasets em 3 níveis:

- **smoke** (~10 casos, < 30s) — todo commit
- **regression** (~100 casos, < 10min) — todo PR
- **bench** (~500 casos) — semanal

Eval **multi-model é first-class**. Roda em 3 tier representatives canônicos (frontier + mid-tier + local), com threshold por tier e matriz de resultados publicada. Falha em qualquer tier bloqueia release. Sem isso, "provider-pluggable" é declaração sem prova. Detalhe em [`PROVIDERS.md`](./PROVIDERS.md) §7.

Eval específicos pra:
- Compaction (preserva goal? cita decisões corretas? funciona em modelo cheap?)
- Plan mode (não escreve? cobre os arquivos certos?)
- Hook flow (PreToolUse bloqueando funciona?)
- Checkpoint/undo (reverte limpo?)
- Provider adapters (cada um cumpre `Provider` interface? capabilities batem com declarado?)
- Constrained generation (schema enforced em cada provider que declara support?)

---

## 17. CLI/UI (TUI interno)

Modelo: **inline rendering, sem framework**. Histórico vai pro scrollback do terminal; região viva (3-15 linhas no fundo) redesenha em cada frame. Spec completo em [`UI.md`](./UI.md).

Espinha dorsal: **event bus tipado**. Harness emite, renderer escuta, `--json` mode serializa o mesmo bus como NDJSON em stdout. Eventos canônicos: `assistant:start|delta|end`, `tool:start|delta|end`, `permission:ask`, `trust:ask`, `memory:write:ask`, `plan:review`, `todo:update`, `subagent:start|update|end`, `bg:start|update|end`, `step:budget`, `checkpoint:create`, `interrupt`, `error`, `warn`. Catálogo completo em `UI.md` §3.

Render: cada elemento é função pura `render(state): string[]`. Sem componentes reutilizáveis no sentido de framework. Os elementos canônicos da região viva:

- **Streaming message** — assistant token-by-token; vira permanente em `assistant:end`.
- **Tool card** — vivo durante execução (spinner + nome + args + elapsed); compacto em scrollback ao terminar.
- **Subagent row** — agrupa eventos do subagent ativo; vira sumário 1-linha ao terminar.
- **Todo list** — bloco vivo opcional acima da status line.
- **Status line** — 1 linha sempre presente: `[profile] · project · model · steps · cost · mem · bg · mcp`. Versões substituídas em estados não-idle (`waiting`, `interrupting`, `compacting`, `wait_for`, `monitor`, plan mode).
- **Modais** — permission, trust, memory write, plan review, critique overlay. Substituem o input dentro da região viva. Pattern: state + focus handler + promise (`UI.md` §5).
- **Thinking indicator** — discreto, durante `thinking:delta`. Some quando output começa.
- **Interrupt prompt** — Ctrl+C com confirmação dupla quando tool em curso.

Princípios de cor/glyph (`UI.md` §6): grayscale + 1 accent (erro vermelho). Sem azul/ciano/magenta/gradiente. Fallback ASCII automático.

Headless (`!isTTY` ou `--json`): bus serializa NDJSON em stdout, renderer não roda. Schemas em `CONTRACTS.md` §2.6.

Não-objetivos: alt-screen, mouse, themes, painéis fixos, layouts split, tabela navegável, hyperlinks (OSC 8), animações além de spinner.

---

## 18. Roadmap v1

**M1 — Fundação (semana 1-2)**
Provider Anthropic + loop básico (autonomous) + 6 tools (`read/write/edit/grep/glob/bash`) + SQLite + TUI mínima (raw ANSI + event bus, ver UI.md) + one-shot mode + Model Registry skeleton.

**M2 — Robustez (semana 3-4)**
Permission engine + compaction + telemetry + abort/budget + eval smoke + headless `--json` + plan mode + trust prompt + output sanitization.

**M3 — Diferencial (semana 5-6)**
Subagents + worktree isolation + MCP client + slash commands + eval regression + resume + checkpoints + `/undo` + `bash_background` + `todo_write` + **Repo Map (tree-sitter)**.

**M4 — Extensibilidade (semana 7-8)**
Hooks system + replay + prompt caching consciente + sandbox `bwrap` opt-in + distribuição (binário Bun) + capability detection completa + **Memory subsystem** (markdown-based, escopo user/project, confirmação humana em writes, audit `memory_events`, slash commands `/memory *`) + **Recap subsystem** (projeção determinística + renderer human/json em M4.1; renderers pr/changelog/slack/terse + LLM com Haiku em M4.2; cross-session + pre-compact em M4.3 — ver [`RECAP.md`](./RECAP.md)) + **`/explain` playbook** (read-only, ver `PLAYBOOKS.md` §6) + **`agent doctor`** (diagnóstico de ambiente) + **Self-critique pass** opt-in (config `critique.mode`, default `off`).

**M5 — Local-first (semana 9-11)**
Provider Ollama + Provider llama.cpp (HTTP) + Constrained generation backend (GBNF + JSON mode) + prompt templates por modelo + Validator framework.

**M6 — Profile orchestrated (semana 12-14)**
Step Graph Executor + 3 DAGs iniciais (`edit_function`, `add_test`, `rename_symbol`) + DAG eval harness + ProfileBadge UI + auto-detect profile via Model Registry.

**M7 — Profile hybrid (semana 15-16)**
Roteamento entre local/frontier + fallback automático + cost telemetry comparativa (local vs frontier por task) + benchmarks documentados.

Cada milestone tem critério de saída **mensurável**:
- **autonomous**: eval pass rate ≥ 85% em smoke; p50 cost < $0.20/task
- **orchestrated**: eval pass rate ≥ 70% em smoke com qwen2.5-coder:14b; p50 cost = $0
- **hybrid**: eval pass rate ≥ 80%; p50 cost < $0.05/task (90% de redução vs autonomous)

---

## 19. Roadmap v2 e além (deferred)

Features que ficam pra depois, **com motivo claro de adiamento e sinal de quando puxar pra v1**:

| Feature | Por que v2 | Sinal pra puxar antes |
|---|---|---|
| **Image input** | depende de protocolo de terminal | usuários colando screenshots em volume |
| **Sandbox por default** | complexidade de empacotamento | incidente de bash escapando policy |
| **`/init` bootstrap** | manual funciona | onboarding repetitivo |
| **OAuth providers** | API key cobre 95% | demanda enterprise |
| **Vector DB / RAG semântico** | repo map + grep resolvem em código | tarefas que ultrapassam codebase pequeno |
| **Workspace multi-repo** | resolver bem 1 repo antes | demanda real de monorepo federado |
| **DAG marketplace / sharing** | comunidade não existe ainda | acumular DAGs úteis localmente primeiro |
| **Local model fine-tuning helper** | Ollama/llama.cpp já cobrem inference | demanda específica e datasets prontos |
| **Speculative decoding entre local e frontier** | complexidade enorme | custo de fallback virar gargalo |
| **Agent hibernation** (sleep + wake-on-event via daemon) | complexidade de daemon + multi-instance | demanda real de waits longos (hours) sem ocupar process |

---

## 20. Riscos arquiteturais

1. **Tool schema bloat** → modelo confunde tools parecidas.
   *Mitigação:* review crítico antes de adicionar tool nova. Eval específico de seleção. 10 tools v1 é teto provisório.

2. **Compaction loss** → resumo perde decisão crítica.
   *Mitigação:* goal re-injection literal + eval específico de compaction.

3. **Permission fadiga** → usuário aceita tudo no piloto automático.
   *Mitigação:* política boa por default, confirmação só onde dói de verdade.

4. **Cost runaway** → loop degenerado queima $20.
   *Mitigação:* budget hard cap, sempre. Sem opt-out.

5. **Lock-in em Anthropic** → se API mudar, dói.
   *Mitigação:* provider interface honesta, sem fingir paridade total.

6. **Terminal capability assumptions** → quebra em SSH/tmux/CI.
   *Mitigação:* detecção real, fallback ASCII, modo headless automático em non-TTY.

7. **Hook como vetor de ataque** → script malicioso em `~/.config/agent/hooks/`.
   *Mitigação:* hooks só de paths confiados; trust prompt em primeira execução; logging em `hook_runs`.

8. **Checkpoint não cobrindo side effects** → `/undo` cria falsa sensação de segurança.
   *Mitigação:* warning explícito antes de undo se step rodou `bash`. Documentar limite com clareza.

9. **Worktree sprawl** → subagents abandonados deixando branches/dirs.
   *Mitigação:* cleanup automático no `Stop`. `agent worktree gc` manual.

10. **DAG sprawl em `orchestrated`** → cada workflow vira DAG, manutenção explode.
    *Mitigação:* DAGs só pra workflows comprovadamente difíceis em local; padrão é `autonomous`. Eval por DAG obrigatório, sem exceção.

11. **Promessa de paridade local↔frontier** → usuário acha que llama-3-8b faz refactor multi-arquivo bem.
    *Mitigação:* Model Registry tem `notes` honestas. Benchmarks comparativos publicados. UI mostra profile ativo. Não esconder limitação.

12. **Constrained generation que mente** → backend "suporta JSON mode" mas o JSON sai mal-formado em 5% dos casos.
    *Mitigação:* eval específico de schema adherence por modelo. Validator + retry como segunda linha. Modelos em que falha > 10% saem do registry como `recommended: false`.

13. **Latência em `orchestrated`** → DAG com 5 nós LLM = 5× mais latência que freeform.
    *Mitigação:* paralelizar nós sem dependência. Cache de output de validator determinístico. Documentar que profile é trade-off latência↔confiabilidade↔custo.

14. **Memória como vetor de injection persistente** → memória escrita uma vez prompt-injeta o agente em todas as sessões futuras.
    *Mitigação:* confirmação humana obrigatória em writes; `inferred` writes desabilitados em diretório não-confiável; `trust: untrusted` em memórias suspeitas (não carrega no contexto base); hash do source no `memory_events` pra rastreio; scanner heurístico de injection antes do write; sandbox de paths; nunca salvar credenciais. Detalhe em §7 do `MEMORY.md`.

15. **Memory bloat** → user salva tudo, índice excede 200 linhas, contexto base derrete.
    *Mitigação:* truncate hard em 200 linhas no índice; `expires` default em project memory; `/memory audit` periódico; eval específico de "memória relevante carregada".

---

## 21. Não-objetivos

Coisas que o projeto **explicitamente não quer ser**:

- **Não é IDE.** Sem extensões VS Code/JetBrains; bridge LSP-style depois, se demanda existir.
- **Não é orquestrador cron.** Use cron do sistema chamando o CLI; não duplicamos scheduling.
- **Não é editor de notebooks.** Tool MCP separada se precisar de Jupyter.
- **Não é interface de voz.** Out of scope.
- **Não é tematizável.** Respeita `NO_COLOR` e capabilities do terminal; não inventamos DSL de tema.
- **Não é marketplace.** Slash commands, agents e hooks são arquivos `.md`/`.toml` em `~/.config`; sem registry central.
- **Não é web app.** CLI primeiro, sempre.
- **Não é linguagem natural pra `bash`.** É agente com tools, executando sob policy.
- **Não é assistente de chat genérico.** Foco em código, repo, terminal.
- **Não é orquestrador de agentes em escala** (workflows distribuídos, multi-tenant). Use Temporal/Airflow. Mas **é** orquestrador de *steps* dentro de uma tarefa (DAG executor) — escopo intra-sessão.
- **Não é solução SaaS.** Local-first, sem servidor obrigatório.
- **Não é serving de modelo local.** Use Ollama/llama.cpp por baixo; este projeto é cliente, não inference engine.
- **Não é "ChatGPT pro terminal"** — é agente com tools, não chatbot.

---

## 22. Insight final

A guerra dos CLI agents não é sobre qual tem mais tools, qual roda mais modelos, ou qual tem TUI mais bonita.

É sobre **quem mede antes de cortar** — e se essa disciplina está espalhada pelo sistema todo ou só no marketing.

Cada decisão deste projeto é instância da mesma diretriz: **meça duas vezes, corte uma**.

- Plan mode mede o plano antes de escrever
- Permission engine mede policy antes de invocar
- Trust prompt mede confiabilidade antes de ler
- Validator mede output antes de aceitar
- Checkpoint mede estado antes de mutar (e dá fallback se mediu errado)
- Eval mede regressão antes de mergear
- `not_checked` declara o que ficou fora da medição
- `assumptions` declara o que foi medido por assumir
- `confidence` declara o grau da medição
- `verify-before-act` em memória verifica antes de agir em fato envelhecido

Sem essa diretriz como espinha, cada decisão individual soa razoável e o conjunto vira mais um wrapper de API. Com ela, vira sistema coerente derivado de uma raiz.

E o agente entrega uma escolha que poucos fazem honestamente: **dois orquestradores, mesma plataforma**. Em `autonomous`, o modelo frontier mede e corta. Em `orchestrated`, o harness mede e o modelo local corta — DAG, validators, constrained generation cuidam de que a medição aconteça mesmo com modelo pequeno. Mesma sessão, mesmas tools, mesmas garantias. O que muda é onde a medição mora.

Local não vira *citizen de segunda*. Vira **opção honesta**, com limites declarados e benchmarks publicados. Quem quer privacidade ou custo zero usa `orchestrated`. Quem quer pico de qualidade usa `autonomous`. Quem quer 80/20 usa `hybrid`.

O resto é consequência. **Meça duas vezes, corte uma** é a única regra que cria todas as outras.
