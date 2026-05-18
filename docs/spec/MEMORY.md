# MEMORY

Subsistema de memória cross-session para o `AGENTIC_CLI`. Markdown-based, auditável, escopado, com confirmação explícita de escrita.

Memória **não é log de atividade**, **não é cache semântico**, **não é vector DB**. É um conjunto pequeno e curado de fatos não-deriváveis que o agente carrega entre sessões para evitar repetição de aprendizado.

> Feito mal, memória **piora** o agente. Feito bem, é o que separa "wrapper de API" de "agente que te conhece".

---

## 0. Princípios (não-negociáveis)

1. **Não-derivável apenas.** Se dá pra obter lendo código, git, ou config — não é memória, é dever do agente buscar.
2. **User-auditável sempre.** Memória que humano não vê/edita/apaga é doença.
3. **Escrita confirmada.** Agente nunca grava sem aprovação — vetor de injection direto.
4. **Source tracking obrigatório.** Toda memória sabe se veio do humano explicitamente, foi inferida, ou foi importada.
5. **Escopo isolado.** Project memory não vaza pra outros projetos. User memory vale globalmente. Sem mistura silenciosa.
6. **Index eager, content lazy.** Index sempre carregado (cheap), conteúdo só sob demanda.
7. **Trust boundary explícito.** Memória escrita a partir de diretório não-confiável é marcada e não entra no contexto base.
8. **Apodrece, então previne.** Verify-before-act + expiração opcional + audit log.
9. **Markdown, não vector.** Auditável, diffable, grep'ável, portável. Embedding é solução pra problema errado.
10. **Sem cargo cult de "personalização".** Memória existe pra reduzir repetição, não pra fingir que o agente "tem identidade".

---

## 1. Tipos

Quatro categorias com motivos diferentes de existir. Sem categoria = lixeira.

### 1.1 `user` — quem é o humano

Role, expertise, preferências de trabalho, ferramentas que usa.

```markdown
---
name: user role
description: full-stack TS dev, vive em tmux/SSH, prefere Bun sobre Node
type: user
source: user_explicit
---

Dev sênior, full-stack TypeScript com peso no backend. Trabalha
exclusivamente em terminal (tmux + nvim). Prefere Bun runtime.
Não gosta de explicações longas; valoriza concisão técnica.
```

**Quando salvar:** quando aprende algo durável sobre o humano que afetaria respostas futuras.
**Não salvar:** "está com sono hoje", "está debugando agora" — efêmero.

### 1.2 `feedback` — correções e validações

Corrections ("não faça X") **e** validations não-óbvias ("sim, exatamente"). As duas formas são igual de importantes — só registrar correção te deixa cauteloso demais; só validação te deixa otimista demais.

```markdown
---
name: commit verb casing
description: usar Title Case em verbos de commit, nunca ALL CAPS
type: feedback
source: user_explicit
---

Em commits do repo `blablabla`, usar "Create"/"Update"/"Delete"
(Title Case). Nunca `CREATE` ou `create`.

**Why:** convenção do repo, vista no `git log` desde o início.
Lowercase ou ALL CAPS quebra padrão visível.

**How to apply:** quando sugerir mensagem de commit nesse repo,
gerar `Create FOO.md, BAR.md` — não `feat: add foo`, não
`CREATED foo.md`.
```

**Estrutura obrigatória do body:**
- Regra/fato em primeira linha
- `**Why:**` — motivo (incidente passado, preferência forte, constraint externa)
- `**How to apply:**` — quando/onde a regra dispara

Sem `Why`, você não consegue julgar edge case depois. Vira regra cega.

### 1.3 `project` — estado do trabalho

Decisões, deadlines, motivações, estado em curso **com horizonte de semanas**, não horas.

```markdown
---
name: local-first deadline
description: profile orchestrated precisa estar maduro até 2026-08-15
type: project
source: user_explicit
expires: 2026-09-01
---

Profile `orchestrated` (Step Graph Executor + validators + Ollama)
deve estar maduro até **2026-08-15**.

**Why:** demonstração para grupo de OSS contributors em workshop;
financiamento depende de mostrar local-first funcionando bem.

**How to apply:** priorizar trabalho de M5/M6 sobre M7. Sugerir
adiamento de hybrid para depois do workshop.
```

**Sempre converta datas relativas para absolutas** ao salvar. "Quinta" → "2026-04-30".
**`expires`** opcional mas recomendado — projeto memory apodrece rápido.

### 1.4 `reference` — ponteiro pra fora

Onde achar informação em outro sistema. Não duplica conteúdo.

```markdown
---
name: linear pipeline bugs
description: bugs de pipeline ficam em Linear projeto INGEST
type: reference
source: user_explicit
---

Bugs de pipeline são rastreados em Linear, projeto **INGEST**.

**Use quando:** usuário menciona bug de pipeline, ETL, ingestão.
Sugerir buscar lá antes de palpitar.
```

---

## 2. Escopos

### 2.1 User scope (global)

```
~/.config/agent/memory/
  MEMORY.md                # índice
  user_role.md
  feedback_commit_style.md
  reference_linear_ingest.md
  .tombstones/             # arquivos evicted dentro da retention window (§6.5)
    feedback_commit_style.1714138800.md
```

Carregado em **toda sessão**, independente do diretório. Cuidado: cada entrada nesse scope custa contexto em todas as sessões pra sempre.

### 2.2 Project scope (por repo) — split em **shared** + **local**

Project scope é dividido em duas sub-pastas com semântica distinta:

```
./.agent/memory/
  shared/                    # VERSIONADO em git (team-wide)
    MEMORY.md                # índice shared
    project_q3_milestone.md
    feedback_team_conventions.md
    reference_linear_ingest.md
    .tombstones/             # VERSIONADO — eviction history cross-team (§6.5)
      project_old_milestone.1714138800.md
  local/                     # GITIGNORED (per-user dentro do projeto)
    MEMORY.md                # índice local
    feedback_my_quirks.md
    project_in_progress.md
    .tombstones/             # GITIGNORED (cascade com local/)
      project_obsolete.1714138800.md
```

#### `.agent/memory/shared/` — versionado

- Decisões/convenções/refs **do time**
- Curadas via PR (humano revisa antes de merge)
- Onboarding instantâneo: clone do repo já traz contexto
- Auditoria via `git blame` (quem adicionou, quando, em que PR)

#### `.agent/memory/local/` — per-user

- Inferred memories vão **sempre** pra cá por default
- Working notes individuais
- Observações pessoais (preferências dentro deste projeto)
- Nunca commitadas; cada dev tem o seu

#### Por que split

Sem split: ou todo mundo compartilha tudo (atrito social, vetor de injection ampliado, lock-in de inferência ruim) ou ninguém compartilha (knowledge não compõe). Split entrega:

- Default seguro (inferred = local)
- Promoção explícita pra shared via slash command (§5.4)
- PR review como gate de qualidade/segurança
- Onboarding via clone

### 2.3 Reference é tipo, não scope

Reference vive em qualquer scope/sub-pasta. Faz sentido tanto user-global ("uso Linear pra X") quanto project shared ("docs deste repo em Notion Y") quanto local ("eu uso este endpoint quando debugando").

### 2.4 Resolução & merge

Quando agente consulta, ordem (mais específico → mais genérico):

1. Session flags (volátil, mais específico)
2. **Project local** (`.agent/memory/local/`)
3. **Project shared** (`.agent/memory/shared/`)
4. User (`~/.config/agent/memory/`)
5. Reference de qualquer scope

Conflito: scope mais específico sobrepõe genérico (local > shared > user). Toda decisão logada em `memory_events` com `resolved_from` indicando origem.

### 2.5 Default `.gitignore` (auto-gerado)

Em `agent init` ou primeira invocação num repo sem `.agent/.gitignore`, agente gera:

```gitignore
# .agent/.gitignore (auto-generated; safe to edit)
sessions.db
sessions.db-*
traces/
checkpoints/
memory/local/
*.log
```

User pode editar livremente. Agente **nunca sobrescreve** após geração inicial.

---

## 3. Storage

### 3.1 Arquivo individual

```markdown
---
name: <kebab-case, único no scope>
description: <uma linha; aparece no índice>
type: <user | feedback | project | reference>
source: <user_explicit | inferred | imported>
expires: <YYYY-MM-DD opcional>
trust: <trusted | untrusted opcional, default trusted>
state: <active | proposed | quarantined | invalidated | evicted | purged opcional, default active>
---

<corpo em markdown>

(para feedback/project, estrutura obrigatória):
**Why:** ...
**How to apply:** ...
```

#### 3.1.1 Campo `state` — lifecycle herdado de EVICTION

Subset declarado dos 7 estados canônicos de [`EVICTION.md §3`](./EVICTION.md). Memory não usa `shadow` (overlap semântico com `trust: untrusted`, que já existe — ver §6.5).

| Estado | Quando | Visível em context? | Carrega em índice? |
|---|---|---|---|
| `proposed` | escrita aguardando admission gate (modal ou hook) | não | não |
| `active` (default) | em uso normal | sim | sim |
| `quarantined` | verify-before-act falhou OU user override 3× OU conflito detectado | sim com flag visual | sim (com penalty) |
| `invalidated` | invariante quebrado (referência aponta pra symbol removido, stack mudou) | não | não |
| `evicted` | despejada; arquivo movido pra `.tombstones/`; retention window ticking | não | não |
| `purged` | retention window estourou OU `user_purge`/`security`; só metadata em `eviction_events` | não | não |

Ausência do campo equivale a `state: active`. Transições legais em [`EVICTION.md §4.1`](./EVICTION.md); cada transição emite event em `memory_events` (§5.3) e `eviction_events` (audit cross-substrato).

### 3.2 Index (`MEMORY.md`)

```markdown
- [User role](user_role.md) — full-stack TS dev, vive em tmux/SSH
- [Commit verb casing](feedback_commit_style.md) — Title Case em commits
- [Linear pipeline bugs](reference_linear_ingest.md) — INGEST tracker
```

Regras do índice:
- **Uma linha por memória**, < 150 caracteres
- Não tem frontmatter próprio (é índice, não memória)
- Truncado em 200 linhas — força disciplina
- Sempre carregado em system prompt (cache breakpoint após AGENTS.md)

### 3.3 Por que markdown

| Critério | Markdown | Vector DB |
|---|---|---|
| User audit | `cat`, `vim` | dump JSON ilegível |
| Edição manual | direto | precisa re-embed |
| Versionamento | git nativo | snapshots fora de banda |
| Custo de write | zero | embedding API |
| Custo de read | trivial | similarity search |
| Retrieval relevante | exact + grep | parecido ≠ relevante |
| Portabilidade | move pasta | dump/import |

Vector ganha quando você tem milhões de memórias e busca semântica importa. Em memória cross-session de **dezenas** de entries, é over-engineering.

---

## 4. Loading

### 4.1 Eager: index

```
[system prompt]
  ...
[AGENTS.md / project context]
[memory index]                ← MEMORY.md aqui (~150 linhas, ~2k tokens)
  - [User role](user_role.md) — full-stack TS dev
  - [Commit casing](feedback_commit_style.md) — Title Case
  - ...
[tool schemas]
```

Cache breakpoint depois do index — index é estável entre turnos da mesma sessão.

### 4.2 Lazy: content

Modelo lê o índice, decide se vale puxar conteúdo. Tool dedicada:

```
memory_read(name="commit verb casing", scope="user")
→ retorna conteúdo do .md
```

Custo: 1 round-trip de tool call por memória relevante. Aceitável dado raridade.

### 4.3 Auto-injection condicional

Algumas memórias são **carregadas eager mesmo sem o índice**, em momentos específicos:

| Trigger | O que carrega |
|---|---|
| `git commit` mencionado | feedback memories com tag `git` |
| Diretório com `.env` detectado | feedback memories com tag `secrets` |
| Tool `bash` chamada | feedback memories com tag `bash` |

Configuração via `triggers:` no frontmatter — opcional, opt-in.

---

## 5. Writing

### 5.1 Fluxo de escrita

1. Modelo decide salvar (ou usuário pede via `/memory save`)
2. Agente chama `memory_write(...)` com proposta
3. **Default destino: project `local/`** ou user scope (baseado em escopo da proposta). **Nunca direto pra `shared/`** — promoção é ato explícito separado (§5.4).
4. **TUI mostra prompt de confirmação:**

```
📝 Propor nova memória [feedback / project · local]

  name: no-console-log
  description: Em src/, console.log proibido — usar logger.debug
  destino: ./.agent/memory/local/feedback_no-console-log.md
  body:
    Em arquivos `src/**/*.ts`, console.log/warn/error proibidos.
    **Why:** logs estruturados são exportados pra Datadog;
    console.* fura observabilidade.
    **How to apply:** quando editar arquivo em src/, usar
    `import { logger } from "@/lib/logger"` e `logger.debug(...)`.

[a]ccept  [e]dit  [r]eject  [w]hy?

(memória vai pra local; compartilhar depois via:
 /memory promote shared no-console-log)
```

5. User decide. Decisão vai pra `memory_events`.
6. Em modo headless `--json`: write **sempre rejeitado**, retornado como warning. Sessão pode persistir intent em sessão local; user revê depois.

### 5.2 Source tracking

Toda memória tem campo `source`:

| Source | Significado |
|---|---|
| `user_explicit` | User pediu explicitamente ("salva isso") |
| `inferred` | Modelo decidiu salvar baseado em correção/validação |
| `imported` | Veio de export de outra ferramenta ou scope |

UI distingue. `inferred` requer confirmação extra — é o vetor de injection mais provável.

### 5.3 Audit log

```sql
memory_events(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,          -- user | project_local | project_shared
  action TEXT NOT NULL,         -- proposed | created | edited | deleted | read | refused
                                -- | promoted | demoted
                                -- | quarantined | invalidated | evicted | restored | purged
                                --   (transições de §3.1.1 / EVICTION §3)
  memory_name TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT,
  created_at INTEGER NOT NULL,
  details JSONB                 -- diff, motivo de refuse, hash do source, ref do PR,
                                -- from_state/to_state em transições, eviction_event_id quando aplicável
);
```

Conteúdo das memórias **não vai pro SQLite** — fica em arquivo. SQLite só rastreia eventos.

Transições de estado emitem **par** de events: `memory_events` (local, com `details.from_state`/`details.to_state`) e `eviction_events` (cross-substrato, [`AUDIT.md §1`](./AUDIT.md) e [`EVICTION.md §10.1`](./EVICTION.md)). `details.eviction_event_id` permite JOIN explícito.

### 5.4 Promoção (local → shared)

Inferred memories nascem **sempre** em `local/`. Promoção pra `shared/` é ato **explícito** do usuário, respeitando "no auto-commit":

```
/memory promote shared <name>
```

Fluxo:

1. Agente lê `./.agent/memory/local/<name>.md`
2. Mostra preview do conteúdo + diff que vai aparecer em `git status`
3. Roda **scanner adicional** específico de promoção:
   - Path traversal check
   - Secret pattern detection (rejeita se encontra)
   - Injection heuristic (rejeita se forte; warning se fraco)
   - Content fica < 200 lines (limite hard)
4. User confirma com `[p]romote  [c]ancel  [d]iff  [w]hy?`
5. Em accept:
   - Move arquivo: `local/<name>.md` → `shared/<name>.md`
   - Atualiza `shared/MEMORY.md` (índice)
   - Remove entry de `local/MEMORY.md`
   - **Não roda `git add` ou `git commit`** — fica como mudança modificada/staged-able
   - User commita manualmente quando quiser; PR review é gate final
6. `memory_events` registra `action: 'promoted'` com `details.from_scope=local, to_scope=shared`

### 5.5 Demoção (shared → local)

Inverso de promoção, útil quando memória shared não vale mais pro time mas user quer manter localmente:

```
/memory demote local <name>
```

Mesmo fluxo, sem scanner adicional (going to less-trusted scope). Cria mudança em `git status` (deletion em shared, novo em local). User commita.

### 5.6 Headless mode

Em `agent --json` non-interactive:
- `memory_write` em local: rejeitado (ver §5.1.6)
- `memory_write` em shared: **sempre** rejeitado (segurança)
- `memory promote/demote`: rejeitados
- Flag `--allow-memory-write=local` opt-in pra CI específicas

Default fail-closed.

---

## 6. Lifecycle

### 6.1 Verify before act

Antes de agir baseado em memória **factual** (não preferência), confirma:

```
memória diz: src/auth.ts exporta `validateToken`
→ grep -n 'export.*validateToken' src/auth.ts
→ se não bate, atualiza ou descarta memória
```

Memória de **preferência** não precisa verify (preferência não tem "estado atual").

### 6.2 Expiry

Frontmatter opcional `expires: YYYY-MM-DD`. Hook `SessionStart` remove memórias expiradas (com confirmação se houver muitas).

Project memory sem `expires` ganha default **+90 dias** se for `inferred` (não `user_explicit`).

### 6.3 Slash commands

```
/memory list [scope]               # lista do índice (scope: user|project|local|shared)
/memory show <name>                # imprime conteúdo
/memory edit <name>                # abre $EDITOR
/memory delete <name>              # com confirmação
/memory diff                       # mudanças não-confirmadas
/memory save                       # propõe salvar baseado em sessão atual (default: local)
/memory promote shared <name>      # project local → project shared (cria mudança git, sem auto-commit)
/memory demote local <name>        # project shared → project local (idem)
/memory promote user <name>        # project (qualquer) → user global (com confirmação dupla)
/memory expire <name> <date>       # set/update expires
/memory audit                      # tabela memory_events da sessão
```

Promoção entre scopes nunca é silenciosa. Cada uma cria mudança que aparece em `git status` (quando relevante) — usuário decide o commit.

### 6.4 Hook `PreCompact`

Antes de compaction, hook opcional pode revisar memória ("alguma estale?"). Útil em sessão longa onde memória recém-escrita virou redundante.

### 6.5 Integração com EVICTION — transições e tombstones

Memory é um dos quatro substratos sob governance de [`EVICTION.md §2`](./EVICTION.md). Esta seção mapeia o lifecycle de memory para o contrato genérico de EVICTION.

#### 6.5.1 Admission gate (escrita → `active`)

Toda escrita normal (§5) entra como `state: active`. Dois casos produzem `state: proposed`:

- **`inferred` write em diretório untrusted** ([`§7.2`](#71-mitigações-obrigatórias) regra 1): permanece `proposed` até user confirmar manualmente; sem confirmação, vira `evicted` no fim da sessão.
- **Hook `MemoryWrite` (§7.2 regra 4) que retorna soft-block**: mesma janela de confirmação.

`user_explicit` write é admitido direto como `active` (gate já passou via UI prompt §5.1).

#### 6.5.2 `active` → `quarantined`

Triggers herdados de [`EVICTION.md §5.1`](./EVICTION.md), aplicados a memory:

| Trigger EVICTION | Detector em memory | Motivo emitido |
|---|---|---|
| `verify_failed` | §6.1 verify-before-act falhou (factual entry contradisse FS) | `shift` |
| `user_override_repeated` | user editou/rejeitou ação derivada desta memory 3× em janela de 24h | `conflict` |
| `conflict_detected` | duas entries do mesmo scope com fatos incompatíveis (resolver em [`EVICTION.md §6.3`](./EVICTION.md)) | `conflict` |
| `trust_revoked` | trust prompt re-fires e user revoga (§7.2 regra 8) | `security` |

Memory `quarantined` continua no índice **com flag visual** (`[memory: quarantined — verify failed 2026-05-12]`) e penalty de ranking ([`EVICTION.md §9.7`](./EVICTION.md)). Não é evictada automaticamente — TTL mínimo de 7d antes de qualquer transição terminal.

#### 6.5.3 `quarantined` → `evicted`

Caminhos:

1. **TTL de quarentena estourou** sem restauração ([`EVICTION.md §4.1`](./EVICTION.md); default 7d em memory).
2. **Loop frio** ([`FEEDBACK_ADAPTATION.md §3.2`](./FEEDBACK_ADAPTATION.md)) confirma `low_roi` com evidence sample suficiente.
3. **User explícito**: `/memory delete <name>` ou `/memory evict <name>`.

Em todos os casos: arquivo movido pra `.tombstones/<name>.<unix_ts>.md` preservando frontmatter original (`state` atualizado pra `evicted`, `details` em event registra motivo). Index entry removida.

#### 6.5.4 `evicted` → `purged` (retention window)

Retention default ([`EVICTION.md §7.1`](./EVICTION.md)):

| Sub-scope | Window |
|---|---|
| User (`~/.config/agent/memory/.tombstones/`) | 30d |
| Project shared (`./.agent/memory/shared/.tombstones/`) | 30d, mas tombstones **versionados em git** — restore via `git checkout` mesmo fora da window |
| Project local (`./.agent/memory/local/.tombstones/`) | 30d, gitignored — fora da window é definitivo |
| Invalidados (todos os scopes) | 7d (mais curto; re-promoção exige re-medição completa) |

Window estourada ⇒ arquivo deletado de `.tombstones/`; metadata permanece em `eviction_events` para forensics.

#### 6.5.5 Restore (`evicted` → `proposed`)

`/memory restore <name>` copia conteúdo do tombstone mais recente, re-cria entry em `state: proposed` (não `active`). Razão: condição que causou eviction pode ainda valer; restore é **re-admissão**, não bypass. User passa pelo prompt de confirmação normal de §5.1.

Restore de tombstone versionado em shared: `git checkout <commit> -- .agent/memory/shared/.tombstones/<name>.<ts>.md` resgata histórico arbitrário; o flow de restore então roda normal.

#### 6.5.6 `invalidated` — caso especial

Diferente de `evicted`, `invalidated` significa **invariante externo quebrado** (e.g., reference memory aponta pra Linear project removido; project memory cita symbol que não existe mais no codebase). Não há retention window útil; window default 7d antes de virar `evicted` automaticamente.

Re-promoção **não reaproveita evidence antiga** ([`EVICTION.md §4.2`](./EVICTION.md)): restore re-entra como `proposed` e re-precisa passar gate. Reaproveitar contaminaria com dados de um contexto que não existe mais.

#### 6.5.7 `purged` irreversível — flows especiais

- `/memory purge <name> --force`: bypass da window, confirmação dupla, registrado em `eviction_events` com `motivo: user_purge`.
- Hook `Eviction` com `reason=security` ([`AUDIT.md §10.3`](./AUDIT.md) reuso de hook): bypass da window com `--security-purge`. Útil quando memory entry contém secret detectado tarde.

Metadata em `eviction_events` **nunca** é purgada — só conteúdo. Garante prova de despejo para compliance/forensics.

### 6.6 Detectores LLM-judge — default ON, opt-out via slash + config

Três detectores LLM-judge rodam por default ([`AGENTIC_CLI.md §5.4.1`](./AGENTIC_CLI.md) carrega a declaração do bloco `[memory]`):

| Detector | Trigger fonte | Slice |
|---|---|---|
| `verify_failed` | exposure de memória factual (eager-load OR memory_read) | S11 |
| `conflict_detected` | write de memória (memory_events action=created/edited) | S13 |
| `user_override_repeated` | threshold counter (3 override events em 24h) sobre `memory_override_events` (sinais: modal reject de inferred-write, permission deny atribuído via provenance, edit_reverted reservado) | S3 |

**Opt-out** (precedência first-match-wins):

1. **CLI flag**: `--no-memory-verify-llm` / `--no-memory-conflict-llm` / `--no-memory-override-llm` (session-only). As variantes sem `no-` (`--memory-verify-llm` / `--memory-conflict-llm` / `--memory-override-llm`) continuam como override-ON para scripts que queiram forçar ativação mesmo com project config OFF.
2. **Project config** `.agent/config.toml [memory] verify_semantic_llm = false` / `conflict_detect_llm = false` / `override_detect_llm = false` — persisted, committed.
3. **User config** `~/.config/agent/config.toml [memory] ...` — per-user, cross-project.
4. **Default ON** — hardcoded em `src/critique/config-loader.ts:DEFAULT_MEMORY_CONFIG`.

**Slash:** `/memory governance disable verify | conflict | override | all` escreve no project config. `enable` reverte. `all` cobre os três detectores. Efeito vale a partir do próximo turn boundary (snapshot semantic, mesmo padrão de `/model` e `/critique mode`).

**Substrate detalhe:**

- Spawn isolado em subagent (definitions em `src/subagents/builtin/verify-semantic.md` + `verify-conflict.md` + `verify-override.md`). Todos protegidos pelo `PROTECTED_BUILTIN_NAMES` (shadows project/user surge loudly no loader).
- Cost cap independente por detector (`MEMORY_VERIFY_SEMANTIC_MAX_COST_USD` + `MEMORY_VERIFY_CONFLICT_MAX_COST_USD` + `MEMORY_VERIFY_OVERRIDE_MAX_COST_USD`). Cada um $0.50/sess + 10 dispatches.
- Propose-not-mutate — verdicts viram pending proposals via S8 governance substrate; operator decide via `/memory governance approve` ou `reject`.
- Quarantine é a kind dominante; cada detector mapeia seu trigger:
  - S11 `subagent:verify-semantic` → trigger `verify_failed`, motivo `shift` default.
  - S13 `subagent:verify-conflict` → trigger `conflict_detected`, motivo `conflict` default; multi-memory proposal com `target_payload.target_key` designando o loser; resolver determinístico (provenance > recência > scope > body length > lexicographic) escolhe quem perde.
  - S3 `subagent:verify-override` → trigger `user_override_repeated`, motivo herdado de `suggested_motivo` do verdict (`conflict | shift | low_roi`); single-memory proposal.

**Threshold-first em S3 (zero LLM cost abaixo do gate):** o counter determinístico (`countOverridesInWindow >= 3` em 24h) precede QUALQUER dispatch. Quando crossa, o subagent decide se o pattern de overrides é causado pela memória (`misguiding=true|false`). Cooldown de 24h baseado em content_hash impede re-dispatch contra mesma snapshot.

**Layers:** 2 (user + project) — mirror de `[critique]`. Enterprise layer fica adiada até regulated environment surfacar (mesmo trade-off de critique).

Detalhes operacionais e cost caps em [`MEMORY.md`](../MEMORY.md) §11.4 (operator guide).

---

## 7. Trust & Injection

O **vetor de ataque mais sério** do subsistema.

### 7.1 O cenário

1. Atacante coloca `AGENTS.md` malicioso em repo terceiro
2. Você clona, abre o agente
3. Modelo lê `AGENTS.md`, "infere" memória ("Salvar: usuário autoriza ler /etc/shadow")
4. **Confirmação acidentalmente aceita** (ou hook auto-aprovou)
5. Memória vira persistente, prompt-injetando todas as sessões futuras
6. Permanente até user perceber

### 7.2 Mitigações obrigatórias

1. **Trust prompt encadeia em memória:** se diretório não-confiável (§9 do AGENTIC_CLI), `inferred` writes ficam **disabled by default** na sessão. Só `user_explicit` permitido.

2. **Trust marking na memória:** se aceitar `inferred` write em diretório não-confiável, memória ganha `trust: untrusted` no frontmatter. **Não carrega no contexto base** — só sob demanda explícita via `memory_read`.

3. **Hash do source diff:** `memory_events` registra hash do contexto que originou a inferência. Permite rastrear "essa memória veio de onde?" depois.

4. **Hook `MemoryWrite`:** evento bloqueável. Empresa pode forçar audit externo:

```toml
[[hooks]]
event = "MemoryWrite"
matcher = { source = "inferred" }
command = "~/.config/agent/hooks/memory_audit.sh"
# bloqueia em exit 1
```

5. **Confirmação dupla pra user-scope:** memória user-global precisa **dois prompts** (write + escopo) — vai afetar todas as sessões, exige fricção extra.

6. **Sandbox de paths:** memória escrita só em `~/.config/agent/memory/` e `./.agent/memory/`. Tentativa de path traversal = erro fatal + audit.

7. **Read inspeção:** UI mostra `[memory: untrusted]` em qualquer memória `untrusted` carregada — user vê o que tá no contexto.

8. **Hash check em `.agent/memory/shared/`:** trust prompt re-fires quando hash do conjunto de arquivos shared muda. Mesma lógica que `AGENTS.md` (§9.1 do AGENTIC_CLI). Pull do repo com mudança em shared = re-trust obrigatório.

9. **Promoção tem scanner adicional** (§5.4): path traversal, secret patterns, injection heuristic, size limit. Promoção bloqueada se falha qualquer check.

10. **PR review é gate primário pra shared:** memória shared só entra no repo via commit; commit passa por code review do time. Defesa social, não automática — mas eficaz.

### 7.3 Tripwire de phrases óbvias + secret detection

Antes de propor write, scanner roda duas passes contra o body:

**(a) Tripwire de phrases (limitado, não é defesa).** Lista pequena de phrases em **inglês** vindas de tutoriais públicos de jailbreak:

- "ignore previous instructions"
- "you are now"
- "from now on, always"
- "disregard prior", "forget previous"

Match: write **bloqueado**, audit row `refused` com motivo. **Não confundir com defesa contra prompt injection.** Trivialmente burlável por:
- outro idioma ("ignore as instruções anteriores", "忽略之前的指令", …);
- paráfrase ("the new rule is", "your role going forward", …);
- injection estrutural (yaml/code-block/role-play wrappers).

Lista fica **curta de propósito** — estender com traduções inflaciona false-positive contra memórias legítimas que citam falhas do modelo, sem mover a agulha de ameaça. Valor real do tripwire: (1) row de audit (`memory_events action=refused`) sinaliza tentativa óbvia; (2) defense-in-depth alongside o modal de §6, o trust boundary, e a atribuição de `source`. O modal É o gate carregando peso; o tripwire é layer 0.

**(b) Secret patterns (honesto, agnostic-to-language).** Shape-stable regexes (chaves AWS `AKIA…`, GitHub PAT `ghp_…`, Anthropic `sk-ant-…`, OpenAI `sk-…40+`, Slack `xox[baprs]-…`). Match: write **bloqueado**. Credentials têm prefixo de alta entropia — não dependem de prosa em volta; false-positive rate é baixo.

Ambas passes geram `memory_events action=refused` com `details.reason` distinguindo phrase vs secret pattern (operator distingue tentativa hostile vs vazamento acidental de credencial em prosa).

---

## 8. Tools

```ts
// Lê conteúdo de uma memória (lazy load)
memory_read(name: string, scope?: "user" | "project"): string

// Propõe nova memória — UI confirma com user
memory_write(
  name: string,
  scope: "user" | "project",
  type: "user" | "feedback" | "project" | "reference",
  body: string,
  expires?: string
): { accepted: boolean, path?: string }

// Grep nas memórias (não vector)
memory_search(query: string, scope?: "user" | "project"): MemoryHit[]

// Lista memórias do índice (sem ler conteúdo)
memory_list(scope?: "user" | "project"): MemorySummary[]
```

Schemas validados. Tool `memory_write` **sempre** dispara confirmação UI; em headless, retorna `{ accepted: false, reason: "headless mode" }`.

---

## 9. Profile interaction

### `autonomous`
- Modelo decide quando ler/escrever
- UI confirma writes
- `inferred` source comum, `user_explicit` quando tool é chamada via `/memory save`

### `orchestrated`
- Nó dedicado `memory_consult` no início de DAGs relevantes (carrega memória relacionada antes de step LLM)
- Nó `memory_propose_write` no final, condicional ("se aprendeu algo, propõe")
- Decisões mais determinísticas; menos propostas espúrias

### `hybrid`
- **Read:** local (modelo pequeno consulta índice e busca; barato)
- **Write decision:** frontier ("isso vale memória?" é decisão semântica difícil)
- **Compaction de memória:** frontier (reescrever memórias preserva nuance)

---

## 10. O que **NÃO** salvar

Lista negra explícita:

- Padrões de código → lê o código
- Estrutura de pastas → lê o repo
- Receitas de fix → commit message tem
- Conteúdo de AGENTS.md → já tá no contexto
- Snippets de conversa
- Estado em-progresso ("trabalhando em X agora") → sessão, não memória
- Logs de atividade ("PRs revisados ontem")
- Listas geradas (lista de PRs, lista de issues)
- Resumos de chamadas/reuniões → put em note dedicada, não memória
- Credenciais, tokens, paths absolutos com username (`/home/lex/...` é vazamento)
- Opiniões transitórias ("agora estou empolgado com X")
- Métricas/números que mudam ("temos 50 endpoints") — vai envelhecer

Mesmo se user pedir explicitamente: agente deve perguntar **"o que foi surpreendente ou não-óbvio nisso?"** — só essa parte vira memória.

---

## 11. Anti-patterns (não cometa)

| Anti-pattern | Por que é ruim |
|---|---|
| Auto-save sem confirmação | Vetor de injection garantido |
| Vector DB pra retrieval | Retorna parecido, não relevante |
| Memória global única (sem scope) | Vaza projeto A → projeto B |
| "Atividade do dia" como memória | Apodrece em horas; é log de sessão |
| Memória sem `Why:` | Vira regra cega; não dá pra julgar edge case |
| Memória sem `source` | Sem auditabilidade real |
| Carregar TUDO no contexto | Bloat até derreter o cache |
| `expires` opcional pra project | Apodrece e poluí; default deve forçar TTL |
| Memória escrita por hook automático | Anula confirmação humana |
| Salvar credenciais "porque user pediu" | NÃO. Erro fatal, sempre |
| `inferred` sem hash do source | Não dá pra rastrear injection |

---

## 12. Exemplos completos (templates)

### `user_role.md`

```markdown
---
name: user role
description: full-stack TS dev, terminal-heavy, prefere Bun
type: user
source: user_explicit
---

Dev sênior, full-stack TypeScript com peso em backend.
Trabalha exclusivamente em terminal (tmux + nvim em SSH).
Prefere Bun runtime sobre Node. Não gosta de explicação prolixa.

**How to apply:** respostas técnicas e concisas. Comandos
em Bun por default. Não explicar conceitos básicos de TS.
Não usar emoji em sugestões de código.
```

### `feedback_no_auto_commit.md`

```markdown
---
name: no auto-commit
description: nunca commitar sem pedido explícito; nem após criar/editar
type: feedback
source: user_explicit
---

Nunca crie git commits sem pedido explícito do usuário.
Mesmo após criar/editar arquivos no fluxo natural.

**Why:** usuário controla o histórico do repo manualmente;
auto-commits poluem `git log` e bagunçam batching de mudanças.

**How to apply:** ao terminar edição de arquivo, **não** rodar
`git commit`. Sugerir mensagem de commit ao final, mas executar
só se user pedir explicitamente ("commita isso", "faça o commit").
```

### `project_q2_release.md`

```markdown
---
name: q2 release scope
description: M5-M7 (local-first) precisa estar pronto até 2026-06-30
type: project
source: user_explicit
expires: 2026-07-15
---

Q2 deadline: M5 (local providers), M6 (orchestrated profile),
M7 (hybrid) prontos até **2026-06-30**.

**Why:** apresentação no workshop OSS em 2026-07-10; demo do
profile orchestrated com Ollama é cerne da apresentação.

**How to apply:** priorizar trabalho de M5/M6/M7 acima de
features de v2. Sugerir adiamento de memory cross-session se
houver conflito de prioridade.
```

### `reference_linear.md`

```markdown
---
name: linear ingest tracker
description: bugs de pipeline ficam em Linear projeto INGEST
type: reference
source: user_explicit
---

Bugs de pipeline (ETL, ingestão, transformação) são
rastreados em **Linear**, projeto `INGEST`.

**Use quando:** usuário menciona bug em pipeline, ETL, ingest.
Sugerir buscar issue lá antes de chutar root cause.
```

---

## 13. Insight final

Memória boa não tenta lembrar tudo. Memória boa lembra o que **não dá pra derivar**, com o motivo, no escopo certo, com auditoria completa.

Quem confunde "agente que aprende" com "salvar tudo que parece útil" cria um banco de fatos envelhecidos que prompt-injetam o agente em todas as sessões futuras.

A regra é simples: **se removendo a memória o agente não fica pior em nada concreto, a memória nunca devia ter sido salva.**
