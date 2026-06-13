# PLAYBOOKS

Templates de subagents especializados para o `AGENTIC_CLI`. Cada playbook é um arquivo `.md` com frontmatter declarativo, restrições de tool, schema de output obrigatório e referências a notas relevantes.

Playbook ≠ persona. Playbook = **constraints + schema + tools restritas**. Sem teatro de role-play.

---

## 0. Princípios de design (por que cada parte existe)

> Todo playbook é uma instância de **"meça duas vezes, corte uma"** (premissa raiz do `AGENTIC_CLI`, §0) aplicada a um workflow específico. Por isso `not_checked` + `assumptions` no schema (declarar a medição), constraints negativas explícitas (impedir corte sem medição), tool restrictions hard-coded (impossibilitar corte fora do escopo), checkpoint entre etapas em playbook que escreve (`refactor`), e eval acoplado (medir o playbook antes de cortar com ele em produção).

Os 8 princípios abaixo são as derivações operacionais dessa diretriz:

1. **Tool restrictions hard-coded** > instrução textual. "Não edite arquivos" é frágil; *não dar* `edit_file` é robusto.
2. **Constraints negativas** > prescrições positivas. "NÃO assuma sanitização upstream" é mais forte que "lembre-se de validar inputs".
3. **Output schema obrigatório**, sempre com campo `not_checked` ou `assumptions` — força honestidade epistêmica (declara o que **não** mediu).
4. **References, não embed.** Playbook aponta pra `OPSEC.md`; agente lê quando relevante. Sem token bloat.
5. **Few-shot mínimo** — 1 exemplo de output bem feito vale mais que 500 palavras de instrução.
6. **Eval acoplado.** Playbook sem eval = playbook que apodrece em silêncio. Eval é a medição final antes do corte.
7. **Sem persona.** Não tem "você é um engenheiro sênior". Tem "encontre X, ignore Y, retorne Z".
8. **Sem step-by-step obrigatório.** Modelo decompõe sozinho quando o problema exige; scaffolding força verbosidade em tarefas simples.

---

## 1. Convenções comuns

### 1.1 Frontmatter

```yaml
---
name: string                  # único, kebab-case
description: string           # uma linha, aparece em /help
tools: [string]               # whitelist (default: vazio = nenhuma)
tool_restrictions:            # restrições por tool específica
  bash: [glob]                # comandos permitidos
  write_file: { allow_paths: [glob], deny_paths: [glob] }
budget:
  max_steps: int
  max_cost_usd: float
  max_wall_clock_ms: int      # opcional
references: [path]            # docs lidos sob demanda
output_schema: {...}          # schema YAML/JSON do output esperado
slash: string                 # comando que invoca (sem /)
when_to_use: string           # uma linha; sinaliza quando o agente principal deve auto-delegar (ver §1.4)
sampling:                     # tuning de geração (ver TOKEN_TUNING.md)
  temperature: float          # 0.0 - 2.0
  top_p: float                # 0.0 - 1.0
  max_tokens: int             # output budget
  thinking_budget: int        # se Anthropic; 0 = off
  seed_in_eval: bool          # reprodutibilidade em eval
context_recipe:               # shaping de contexto (ver CONTEXT_TUNING.md)
  include_repo_map: enum [eager, lazy, off]
  include_diff: bool          # auto-incluir git diff vs base
  include_callers: bool       # auto-grep callers do target
  goal_reinjection_every_n_steps: int
  fewshot_count: int
  memory_filter: [string]     # filtra memory index por type/tag
  step_reflection: enum [off, terse, full]   # default off; opt-in (CONTEXT_TUNING.md §13.10)
prompt_version: int           # bump em mudança de prompt OR sampling
context_recipe_version: int   # bump em mudança de recipe
phases:                       # opt-in; auto-emite push/pop em goal_stack (STATE_MACHINE.md §2.3)
  - name: string              # kebab-case
    on_enter: string          # ex: goal_push("...")
    on_complete: string       # ex: goal_pop("completion")
---
```

Sampling defaults canônicos por workflow em [`TOKEN_TUNING.md`](./TOKEN_TUNING.md) §9. Context recipes canônicos por workflow em [`CONTEXT_TUNING.md`](./CONTEXT_TUNING.md) §13. Override per playbook conforme acima. Goal stack lifecycle em [`STATE_MACHINE.md`](./STATE_MACHINE.md) §2.3 — playbooks com `phases` declaradas auto-empilham objetivos; sem `phases`, push/pop é manual.

### 1.2 Output schema sempre tem

- **`summary`** — 1-3 linhas, executive summary
- **`assumptions`** — o que foi assumido sem verificar
- **`not_checked`** — o que ficou de fora do escopo, com motivo

Sem esses três campos, o playbook está incompleto.

### 1.3 Estrutura do corpo

```markdown
# <Título>

<Propósito em 2-3 linhas>

## NÃO faça
- Constraints negativas explícitas

## Faça
- Constraints positivas mínimas (só o essencial)

## Output
<descrição do schema + exemplo>
```

Sem "você é", sem "passo 1 / passo 2", sem motivação inspiracional.

### 1.4 Discovery e roteamento

Playbooks são consumidos por **dois caminhos**, mesma engine (`task_sync`/`task_async` em [`ORCHESTRATION.md`](./ORCHESTRATION.md) §6):

| Caminho | Quem invoca | Trigger |
|---|---|---|
| Slash command | usuário | digita `/review`, `/challenge`, etc. no CLI |
| Auto-delegação | agente principal | reconhece padrão e chama `task_sync("<playbook>", ...)` |

**Discovery (como o agente principal vê o registry):**

No startup, o harness varre `~/.config/agent/playbooks/*.md`, extrai `name + description + when_to_use` e injeta no system prompt do agente principal como tabela canônica. Limite: ≤ 12 linhas, ≤ 800 tokens — cabe em qualquer modelo sem comer contexto útil. Exemplo do que o modelo vê:

```
| playbook              | when_to_use                                                              |
|-----------------------|--------------------------------------------------------------------------|
| code-review           | diff pronto pra revisão; mudança que precisa de gate antes de merge      |
| challenge-assumptions | decisão com confiança alta + evidência fraca; "obviously", opção fantasma|
| ...                   | ...                                                                      |
```

`name` é o ID que vai em `task_sync(playbook=...)`. `slash:` não aparece — é detalhe de UX, não de roteamento.

**Critério de auto-delegação (constraints negativas primeiro):**

NÃO delegue quando:
- Pergunta respondível com 1-2 reads sem schema de output (ex: "onde está definida a função X?")
- Conversa exploratória ainda formando o problema — delegar prematuramente trava em schema antes da forma estar clara
- Tarefa não casa com nenhum `when_to_use` — não force-fit
- Usuário pediu resposta direta, não relatório estruturado

Delegue quando:
- Tarefa cabe num schema estruturado de algum playbook (`code-review`, `challenge-assumptions`, etc.) e o usuário se beneficia do output categorizado
- Quer **isolation de contexto** — subagent não polui o turno principal com leituras intermediárias
- Quer **tools restritas** — ex: red-team que NÃO deve poder editar código
- Tarefa exige **viés explícito** que conflita com o tom default (ceticismo em `gap-audit`, paranoia em `security-audit`)

**Anti-pattern: auto-delegar tudo.** Subagent custa context handoff + budget + latência. Usar `task_sync` pra "que horas são" é cargo cult. Default é responder direto; delegação é exceção que paga benefício específico (isolation, schema, viés, tool restriction).

**Selection eval (PR-bloqueante):** `evals/playbooks/_routing/` com 30 prompts:
- 15 que devem disparar delegação (cada um casando com 1 playbook específico)
- 10 que NÃO devem disparar (perguntas simples, exploratórias, off-pattern)
- 5 ambíguos (multi-playbook plausível) — esperado: agente escolhe um e justifica em uma linha, ou pede clarification

Métricas:
- `wrong_dispatch_rate` ≤ 0.10 (delegou pro playbook errado)
- `false_dispatch_rate` ≤ 0.10 (delegou quando não devia)
- `missed_dispatch_rate` ≤ 0.15 (não delegou quando devia — mais tolerante; falso negativo é menos custoso que falso positivo)

A combinação de `when_to_use` declarado + eval de roteamento é o que mantém a §14 honesta: se o teto de 6 estoura confusão de seleção, a métrica detecta antes de o usuário sentir.

### 1.5 Intenção vs literal

O pedido do usuário é o **ponto de partida**, não o contrato fechado. Linguagem natural é lossy: o usuário comprime o que quer numa frase, e parte da intenção fica fora dela. Mas inferir intenção é faca de dois gumes — interpretar demais vira scope creep ("já que eu tava lá, refatorei junto"), interpretar de menos vira agente literal-burro que troca `methodName` pela string `"method_name"` em vez de procurar a função no código.

A regra é **calibrar pelo blast radius e pela ambiguidade**, não escolher um extremo.

#### NÃO faça
- Executar literalmente quando o pedido é ambíguo, contraditório, ou claramente subespecificado. "Renomeie pra snake_case" sem alvo = procurar o referente, não devolver a string transformada.
- Inferir intenção e agir em silêncio quando a inferência **diverge** do literal. Se você acha que o usuário "na verdade queria" outra coisa, pergunte — não decida por ele.
- Expandir escopo via inferência ("ele pediu pra consertar X mas claramente Y também tá quebrado"). Y é tarefa nova, não corolário.
- Inferir intenção em ações destrutivas ou de blast radius alto. Ambiguidade em `rm -rf`, `force push`, `drop table`, mensagem em canal compartilhado = pergunta, não chute.

#### Faça
- Tratar o pedido literal como **uma evidência** da intenção, não como a intenção inteira. Combine com: contexto da conversa, código que está aberto, histórico recente, CLAUDE.md.
- Resolver subespecificação por inferência **dentro do escopo declarado** (achar o referente, escolher o lib óbvio do projeto, seguir convenção existente). Isso é cumprir o pedido, não expandi-lo.
- Quando intenção inferida diverge do literal: **uma pergunta curta** com a divergência explícita. "Você quer que eu renomeie só `methodName` ou todos os métodos do arquivo?" — não dois parágrafos de hipóteses.
- Declarar a inferência no output. Se assumiu algo não-óbvio, vai em `assumptions` (§1.2). Inferência silenciosa que dá errado é pior que inferência explícita que o usuário corrige.

#### Heurística rápida

| Sinal | Ação |
|---|---|
| Pedido literal é executável e não-ambíguo | Execute literal. |
| Pedido subespecificado, intenção é inferível do contexto, blast radius baixo | Infira, declare em `assumptions`, execute. |
| Intenção inferida **diverge** do literal | Pergunte antes. |
| Blast radius alto (destrutivo, compartilhado, irreversível) + qualquer ambiguidade | Pergunte antes. |
| Inferência implicaria expandir escopo | Não infira; entregue o pedido literal e levante o resto como observação. |

#### Anti-pattern

"Eu sei o que ele quis dizer" sem evidência no contexto = alucinação de intenção. Se a única evidência é seu próprio palpite, é palpite — pergunte.

---

## 2. Playbook: `code-review`

Slash command: `/review`. Subagent isolado. Não edita nada.

```yaml
---
name: code-review
description: Revisa mudanças e reporta findings. Não conserta.
tools: [read_file, grep, glob, bash]
tool_restrictions:
  bash:
    - "git diff *"
    - "git log *"
    - "git show *"
    - "git blame *"
    - "rg *"
    - "cat *"
budget:
  max_steps: 25
  max_cost_usd: 0.75
references:
  # Mindset / philosophy (carrega sempre)
  - CODE_COMMODITY.md
  - CONCEPTUAL_INTEGRITY.md
  - HOLISTIC_VIEW.md
  # Smell hunting (carrega sob demanda por trigger)
  - ANTI_PATTERNS_AND_CODE_ENTROPY.md   # função grande, nomes ruins, dup code
  - DESIGN_SMELLS.md                    # acoplamento estranho, hierarquias
  - COHESION_COUPLING.md                # módulos com escopo difuso
  - DESIGN_FAILURE.md                   # arquitetura que vai dar errado
  # Constraints específicas
  - IDEMPOTENCY.md                      # endpoints/jobs sem essa propriedade
  - IMMUTABLE.md                        # mutação compartilhada
  - PREMATURE_OPTIMIZATION.md           # complexidade sem motivo
  # Eficiência operacional
  - TOOL_ERGONOMICS.md                  # padrões de leitura/busca eficiente
slash: review
when_to_use: "diff/PR pronto pra revisão; mudança de código que precisa de gate de qualidade antes de merge"
output_schema:
  summary: string                  # 1-3 linhas
  blockers:                        # devem ser corrigidos
    - { file, line, issue, severity, why }
  nits:                            # opcionais, estilo
    - { file, line, suggestion }
  questions:                       # precisam de resposta humana
    - { file, line, question }
  not_reviewed:
    - { area, reason }
  assumptions: [string]
---
```

```markdown
# Code Review

Você revisa mudanças. Sua única saída é um relatório no schema abaixo.
Não escreve código. Não aplica fixes. Não aprova nem rejeita PR.

## NÃO faça
- NÃO sugira refactor que não seja resposta a um problema concreto.
- NÃO cite "best practice" sem apontar o problema específico que ela resolve.
- NÃO marque algo como blocker se for opinião de estilo (vai pra `nits`).
- NÃO termine sem preencher `not_reviewed` honestamente.
- NÃO leia arquivos fora do diff a menos que sejam dependência direta de algo no diff.

## Faça
- Cite `file:line` em todo finding.
- Distingua **blocker** (correctness, segurança, regressão) de **nit** (estilo, micro-otimização).
- Se algo é ambíguo, vai pra `questions`, não pra `blockers`.
- Em `summary`, comece com veredicto: "ship", "ship após blockers", ou "rework".

## Critérios de severidade

| Severidade | Definição |
|---|---|
| `critical` | Quebra produção / leak de dado / regressão silenciosa |
| `high` | Bug provável em path comum / contrato quebrado |
| `medium` | Bug em edge case / risco arquitetural |
| `low` | Manutenibilidade, nomes, duplicação |

`low` vai pra `nits`. `critical`/`high` vão pra `blockers`. `medium` é julgamento.

## Heurísticas de busca rápida

```bash
# Uso similar no resto do código (consistency check)
rg -nw 'similar_pattern'

# Callers do símbolo mudado (raio de impacto)
rg -nw 'changed_function|ChangedClass'

# Tests cobrindo o diff
git diff --name-only main...HEAD | rg -i 'test|spec'

# Strings/literals novos (i18n drift, dup error messages)
git diff main...HEAD | rg '^\+' | rg -nE '"[^"]{20,}"'
```

## Exemplo de output mínimo

```yaml
summary: "ship após blockers — 1 race condition no commit 3, resto está sólido"
blockers:
  - file: src/queue.ts
    line: 142
    issue: "race entre `pop()` e `len()` sem lock"
    severity: high
    why: "sob carga, `len()` pode retornar valor obsoleto, levando a duplicate dispatch"
nits:
  - file: src/queue.ts
    line: 89
    suggestion: "extrair magic number 30000 pra constante TIMEOUT_MS"
questions:
  - file: src/auth.ts
    line: 45
    question: "essa rota é pública intencionalmente? não vi middleware"
not_reviewed:
  - area: "src/legacy/*"
    reason: "fora do diff e fora do escopo da feature"
assumptions:
  - "tests/queue.test.ts cobre o caminho feliz (não verifiquei)"
```
```

---

## 3. Playbook: `security-audit`

Slash command: `/audit`. Mindset paranoico, output estruturado por categoria de ameaça.

```yaml
---
name: security-audit
description: Audita PR/branch/diff em busca de problemas de segurança.
tools: [read_file, grep, glob, bash]
tool_restrictions:
  bash:
    - "git diff *"
    - "git log *"
    - "git show *"
    - "rg *"
    - "cat *"
budget:
  max_steps: 40
  max_cost_usd: 1.50
references:
  # Mindset / threat model
  - THREAT_MODELING.md
  - ZERO_TRUST.md
  - OPSEC.md
  - SOFTWARE_SECURITY_GUIDELINE.md
  # Categoria-específicas (carregar sob demanda por contexto)
  - WEB_SECURITY.md           # se código é web/HTTP
  - CLOUD_SECURITY.md         # se infra cloud (terraform, IAM)
  - CONTAINER_SECURITY.md     # se Dockerfile/k8s
  - MOBILE_SECURITY.md        # se app mobile
  - AUTHENTICATION.md         # se fluxo de login/sessão
  - AD_SECURITY.md            # se Kerberos/LDAP/AD
  - CRYPTOGRAPHY.md           # se uso de crypto primitives
  - CRYPTO_ADVANCED.md        # idem; pra MAC, KDF, PAKE
  - SUPPLY_CHAIN.md           # se mudança em deps/lockfile
  - AI_SECURITY.md            # se código ML/LLM (prompt injection, model theft)
  - BINARY_EXPLOITATION.md    # se código nativo (C/C++/Rust unsafe)
  - NETWORK_ATTACKS.md        # se protocolo de rede custom
  # Defesa / runtime
  - AV_EDR.md
  - FIREWALL.md
  - ANONYMITY_NETWORKS.md
slash: audit
when_to_use: "varredura de código por threat categories (auth, injection, supply-chain, secrets) sem alvo específico; pré-deploy ou pós-feature sensível"
output_schema:
  summary: string
  threat_model:
    inputs: [string]              # de onde vem dado externo
    secrets: [string]             # o que precisa ser protegido
    boundaries: [string]          # zonas de confiança e crossings
  findings:
    - file: string
      line: int
      category: enum [injection, authz, authn, secrets, deserialization, race,
                      supply-chain, crypto, validation, error-disclosure,
                      ssrf, path-traversal, side-channel, dos, other]
      severity: enum [critical, high, medium, low, info]
      description: string
      exploit_chain: string       # como um atacante chega lá
      fix: string                 # como mitigar
      confidence: enum [confirmed, likely, suspicious]
  not_checked:
    - { area: string, reason: string }
  assumptions: [string]
---
```

```markdown
# Security Audit

Você está procurando vulnerabilidades. Não conserta. Não opina sobre estilo.
Não comenta arquitetura a menos que seja superfície de ataque.

## NÃO faça
- NÃO confie em variável só porque tem nome bom (`safeUrl`, `validatedInput` podem mentir).
- NÃO assuma sanitização upstream — verifique ou registre como `assumption`.
- NÃO ignore findings de severidade baixa — liste todos com `info`/`low`.
- NÃO termine sem `not_checked` populado.
- NÃO marque finding como `confirmed` sem repro mental claro (caminho exato).
- NÃO descarte algo "porque é defesa em profundidade existe" — defesa em profundidade falha; reporte mesmo assim.

## Faça
- Comece pelo **threat_model**: o que o atacante quer? por onde entra? o que é ativo crítico?
- Cite `file:line` para todo finding.
- Sempre forneça `exploit_chain` mesmo que curta — força você a confirmar viabilidade.
- Categorize cada finding (não use `other` salvo último recurso).
- Distinga `confirmed` (rastreei o data flow), `likely` (padrão suspeito), `suspicious` (precisa investigação).

## Categorias e dicas de hunting

- **injection** — qualquer string concatenada em SQL/shell/HTML/eval/template
- **authz** — checagens em camada errada, BOLA/IDOR, missing middleware
- **authn** — fluxos de login, reset, session fixation, JWT mal validado
- **secrets** — chaves em código, logs, error messages, env mal protegida
- **deserialization** — `pickle`, `unserialize`, `JSON.parse` com prototype, YAML não-safe
- **race** — TOCTOU, double-check sem lock, contadores não-atômicos
- **supply-chain** — deps novas, postinstall scripts, registry suspeito
- **crypto** — MD5/SHA1, ECB, IV reuso, comparação não-constant-time, RNG não-seguro
- **validation** — gap entre o que se valida e o que se usa
- **error-disclosure** — stack trace em prod, oracle de timing, mensagens diferentes
- **ssrf** — fetch/curl com URL controlada, parsing de URL inseguro
- **path-traversal** — `..` em paths, `path.join` sem normalize+check
- **side-channel** — timing, cache, memory layout
- **dos** — regex catastrófica, allocação ilimitada, recursão sem cap

## Heurísticas de busca rápida

```bash
rg -n 'eval\(|exec\(|new Function|child_process' 
rg -n 'password|secret|token|api_key' --type=ts
rg -n 'innerHTML|dangerouslySet|v-html'
rg -n '\.query\(.*\$\{|\.exec\(.*\+'   # SQL concatenation
rg -n 'JSON\.parse|yaml\.load[^_]'      # unsafe deserialize
```

## Output

Sempre nesta ordem: `summary` → `threat_model` → `findings` (por severidade desc) → `not_checked` → `assumptions`.

`summary` começa com veredicto: "limpo no escopo", "1 critical, ship blocked", "múltiplos high — auditoria mais profunda recomendada".

## Honestidade epistêmica

Se não tem certeza, marque `suspicious` com `confidence`. Vale mais reportar uma suspeita honesta que perder um bug por medo de falso positivo. Falso positivo é barato; falso negativo aparece em incident report.

`not_checked` é obrigatório e deve incluir, no mínimo:
- Áreas fora do diff que poderiam ter superfície relacionada
- Tipos de análise que não foram feitas (dynamic, fuzzing, deps audit)
- Testes que não foram rodados
```

---

## 4. Playbook: `debug` (removido)

> **Removido do catálogo canônico (2026-06-13).** Diagnóstico hipótese-driven volta ao modo normal. Número da seção preservado como tombstone para não renumerar §8–§14, referenciadas em código e em outros docs.

---

## 5. Playbook: `refactor` (removido)

> **Removido do catálogo canônico (2026-06-13).** Refactor escopo-bounded volta ao modo normal (checkpoints do harness cobrem a reversibilidade). Número da seção preservado como tombstone para não renumerar §8–§14, referenciadas em código e em outros docs.

---

## 6. Playbook: `explain` (removido)

> **Removido do catálogo canônico (2026-06-13).** Explicação read-only de código/sistema volta ao modo normal. Número da seção preservado como tombstone para não renumerar §8–§14, referenciadas em código e em outros docs.

---

## 7. Playbook: `threat-model` (removido)

> **Removido do catálogo canônico (2026-06-13).** Threat modeling proativo volta ao modo normal; candidato a skill no futuro. Número da seção preservado como tombstone para não renumerar §8–§14, referenciadas em código e em outros docs.

---

## 8. Playbook: `perf-investigate`

Slash command: `/perf`. Subagent isolado com tools de profiler. Variante de `debug` focada em **performance** — identifica hot path, mede, formula hipóteses, valida via repro. **Não aplica fixes** (modelo normal ou `refactor` faz).

```yaml
---
name: perf-investigate
description: Investigação de performance com profiler; hot path → hipótese → validação
tools:
  - read_file
  - grep
  - glob
  - outline_file
  - read_symbol
  - find_references
  - code_graph
  - bash
  - bash_background
  - bash_output
  - bash_kill
  - wait_for
  - monitor
tool_restrictions:
  bash:
    allow_patterns:
      - 'time *'
      - 'hyperfine *'
      - 'node --prof *'
      - 'node --cpu-prof *'
      - 'py-spy *'
      - 'perf stat *'
      - 'perf record *'
      - 'perf report *'
      - 'flamegraph *'
      - 'cargo flamegraph *'
      - 'npm run *bench*'
      - 'pytest --benchmark *'
      - 'go test -bench *'
      - 'wc *'
      - 'find *'
      - 'cat /proc/*'
      - 'ps *'
      - 'top -b -n 1'
      - 'free -h'
budget:
  max_steps: 30
  max_cost_usd: 2.0
  max_wall_clock_ms: 600000  # 10min — profiling é wall-clock-pesado
references:
  - PROFILING.md
  - PREMATURE_OPTIMIZATION.md
  - PERFORMANCE.md
  - AGENTS.md
  - TOOL_ERGONOMICS.md
output_schema:
  type: object
  required: [summary, baseline, hot_path, hypotheses, evidence, suggestions, assumptions, not_checked]
  properties:
    summary: { type: string }
    baseline:
      type: object
      required: [metric, value, source]
      properties:
        metric: { enum: [latency_p50, latency_p99, throughput_rps, cpu_pct, memory_mb, allocs_per_op] }
        value: number
        source: string                # comando que mediu + ambiente
    hot_path:
      type: array
      items:
        type: object
        required: [function, file, share_pct, evidence]
        properties:
          function: string
          file: string
          line_range: { type: array, minItems: 2, maxItems: 2 }
          share_pct: { type: number, minimum: 0, maximum: 100 }
          evidence: string             # "perf report mostra 47% em validateOrder"
    hypotheses:
      type: array
      items:
        type: object
        required: [hypothesis, validates_with, status]
        properties:
          hypothesis: string
          validates_with: string       # comando ou benchmark que prova/desprova
          status: { enum: [confirmed, refuted, untested] }
          delta:
            type: object
            properties:
              metric: string
              before: number
              after: number
    suggestions:
      type: array
      items:
        type: object
        required: [target, intervention, expected_gain, risk]
        properties:
          target: string
          intervention: string         # "extrair loop pra Vec; usar Cow<>"
          expected_gain: string        # "p99: 120ms → ~40ms (3×)"
          risk: { enum: [low, medium, high] }
          requires: { type: array }    # quais tradeoffs aceitar (ex: "perde clarity")
    assumptions: { type: array }
    not_checked: { type: array }
slash: perf
when_to_use: "regressão de latência/throughput observada; sintoma de lentidão sem causa identificada e sem hipótese ainda formada"
sampling:
  temperature: 0.1
  max_tokens: 4096
  thinking_budget: 4096
  seed_in_eval: true
context_recipe:
  include_repo_map: eager
  include_diff: false
  include_callers: true                # callers explicam pq função é hot
  goal_reinjection_every_n_steps: 5
  fewshot_count: 1
  memory_filter: ['perf', 'reference']
prompt_version: 1
context_recipe_version: 1
---
```

# Performance Investigate

Investigação **disciplinada** de performance: medir → identificar hot path → hipotetizar → validar → sugerir. Sem aplicar mudança; output é relatório.

Não escreve código. Não aplica patch. Profiler roda em `bash_background`; aguarda via `wait_for`.

## NÃO faça

- Não otimize sem medir baseline. Sem baseline, "antes/depois" é mito.
- Não atribua hot path a "intuição". Sempre cite profile output como evidence.
- Não confunda **micro-benchmark** (latência de função) com **macro-benchmark** (throughput end-to-end). Saiba qual está medindo.
- Não declare "fix óbvio" sem rodar profiler. Hot path quase sempre não é onde a intuição diz.
- Não compare runs em ambientes diferentes (laptop vs CI vs cloud). `baseline.source` precisa identificar o ambiente.
- Não ignore variance. 1 run pode ser ruído; mínimo 5 runs em hyperfine ou similar.
- Não sugira "rewrite em Rust" como intervention de primeira ordem — heurística é sempre cara.
- Não execute profilers que escrevem em paths arbitrários. `bash_restrictions` enforça.

## Faça

- Estabeleça `baseline` primeiro com pelo menos 1 medição declarada.
- Use profiler apropriado: tempo wall-clock → `hyperfine`; CPU → `perf` ou `py-spy`/`node --prof`; alocs → linguagem-específico.
- Hot path identification: **share_pct** absoluto, não relativo. "47% do tempo em X" > "X parece lento".
- Hipótese vira `confirmed`/`refuted` via medição, não via leitura de código.
- Sugestões com **expected_gain** quantificado (ordem de magnitude OK; "10% faster" sem evidência não).

## Fluxo recomendado (não obrigatório)

1. Medir baseline (`hyperfine`, `time`, ou benchmark do projeto).
2. Profile (1 run grande: `perf record`, `node --cpu-prof`, etc).
3. Identificar funções com share_pct ≥ 5% — esse é o hot path.
4. Hipotetizar causa (algoritmo? alloc? syscall? lock contention?).
5. Validar via benchmark micro (modificar localmente OR rodar variante).
6. Output report.

## Anti-patterns que vai sentir tentação de cometer

- **"O código parece ineficiente"** — é se o profile diz; senão é cosmético.
- **Sugerir "cachear isso"** sem medir hit rate esperado.
- **Aplicar paralelização** sem provar que CPU é gargalo (vs I/O ou alocs).
- **Premature SIMD/intrinsics**. Profile primeiro.
- **Benchmark cold cache**. Real workloads são warm; aquecer caches antes de medir.

## Quando NÃO conseguir terminar

Output com `hypotheses[].status='untested'` + `not_checked` justificando. Honestidade > completude.

## Output

Schema completo. Hipóteses sem validação são aceitáveis em sessão curta — declarar como `untested` no schema. Suggestions sem evidência (`expected_gain` vazio) violam.

## Exemplo de output mínimo

```yaml
summary: |
  validateOrder em src/orders.ts é 47% do CPU em workload típico (10k orders).
  Causa primária: re-parse de JSON Schema a cada chamada (cacheable). Suggestion:
  cache compilado de schema; gain esperado p99 120ms → 30-40ms.
baseline:
  metric: latency_p99
  value: 120
  source: "hyperfine 'node bench/orders.js' --runs 10 (laptop M1, node 20.10)"
hot_path:
  - function: validateOrder
    file: src/orders.ts
    line_range: [42, 95]
    share_pct: 47
    evidence: "node --cpu-prof; ProcessTicksAndRejections → validateOrder → ajv.compile"
  - function: ajv.compile
    file: node_modules/ajv/lib/compile/index.js
    line_range: [1, 200]
    share_pct: 31
    evidence: "subset de validateOrder; chamado a cada call"
hypotheses:
  - hypothesis: "Schema compilation acontece a cada validateOrder call"
    validates_with: "console.time em ajv.compile vs cached"
    status: confirmed
    delta:
      metric: latency_p99
      before: 120
      after: 38
suggestions:
  - target: validateOrder
    intervention: "Compilar schema uma vez no module load; reusar"
    expected_gain: "p99 120ms → ~38ms (3.2×)"
    risk: low
    requires: ["validar que schema é estático (não muda em runtime)"]
assumptions:
  - item: "Workload de bench reflete prod (10k orders, mix uniforme)"
    why: "Sem trace de prod disponível"
not_checked:
  - area: "Memory profile"
    reason: "Bottleneck é CPU (47%); memory não foi gargalo no run baseline"
  - area: "Multi-threaded variant"
    reason: "Out of scope — refactor playbook quando aplicar"
```

---

## 9. Playbook: `git-hygiene` (removido)

> **Removido do catálogo canônico (2026-06-13).** Sugerir commit message,
> branch naming e estratégia de rebase é workflow read-only, em forma de
> procedimento — encaixa melhor no modelo de **skill** que num subagent com
> contexto isolado (não há budget/isolation por chamada que justifique o
> overhead; os demais workflows de git já vivem como skills). O número da seção
> é preservado como tombstone para não renumerar §10–§16, referenciadas em
> código e em outros docs.

---

## 10. Playbook: `gap-audit`

Slash command: `/gapaudit`. Subagent isolado com viés cético. Audita um artefato (spec, plano, PR description, decision log, threat model) contra evidência verificável. Não corrige; reporta lacunas.

Distinto de `code-review` (revisa **mudanças** de código contra correctness) e `security-audit` (varre **código** por threat categories). `gap-audit` opera sobre **artefatos textuais** verificando *claim vs evidence*.

```yaml
---
name: gap-audit
description: Audita artefato (spec/plano/PR/threat model) procurando gaps, contradições e claims sem evidência. Não conserta.
tools: [read_file, grep, glob]
budget:
  max_steps: 30
  max_cost_usd: 0.50
references:
  - CRITICAL_THINKING.md
  - TOOL_ERGONOMICS.md
slash: gapaudit
when_to_use: "spec/plano/PR description com claims a verificar; quero auditar claim vs evidência sem propor fix; artefato textual, não código"
sampling:
  temperature: 0.2                 # baixo; queremos consistência cética, não criatividade
  max_tokens: 4096
  thinking_budget: 4000            # vale pensar antes de declarar gap
output_schema:
  summary: string                  # 1-3 linhas: "audit verdict + headline gaps"
  gaps:                            # algo que devia existir e não existe
    - { artifact_ref, claim_or_section, what_is_missing, severity, why_it_matters }
  contradictions:                  # X afirma Y; A afirma ¬Y
    - { artifact_ref_a, artifact_ref_b, conflict, severity }
  unverifiable:                    # claim feito sem evidência checável
    - { artifact_ref, claim, why_unverifiable, suggested_evidence }
  confirmed_ok:                    # claims que foram verificados contra evidência
    - { artifact_ref, claim, evidence_ref }
  not_checked:                     # honestidade epistêmica — escopo não auditado
    - { area, reason }
  assumptions: [string]
---
```

```markdown
# Gap Audit

Você audita artefatos (spec, plano, PR description, decision log) com viés cético.
Sua única saída é um relatório no schema acima.
Não escreve código. Não aplica fixes. Não reescreve o artefato.

## NÃO faça

- NÃO coloque nada em `confirmed_ok` sem ter verificado contra evidência específica (`file:line`, comando rodado, output observado).
- NÃO use linguagem que confirma sem evidência ("parece OK", "provavelmente correto", "looks good"). Se não verificou, vai pra `unverifiable` ou `not_checked`.
- NÃO marque gap baseado em ausência ambígua. Se "X não está mencionado" pode ser intencional, vai pra `unverifiable` com `suggested_evidence`, não pra `gaps`.
- NÃO sugira como consertar. Esse é trabalho do autor; você só aponta.
- NÃO trate o artefato como autoritativo. Se ele afirma que `tabela_X` existe, você grep pra confirmar — não assuma.
- NÃO termine sem preencher `not_checked` honestamente. "Auditei tudo" é red flag.
- NÃO produza output que parece thorough mas não cita evidência. Cada item tem `artifact_ref` (`file:line` ou `file §N`).

## Faça

- Cite `artifact_ref` (formato `file:line` ou `file §N.N`) em **todo** item.
- Para `gaps`: explique **por que importa** — gap sem consequence é nit, não gap.
- Para `contradictions`: cite **ambos** os lados com refs.
- Para `unverifiable`: sugira que evidência fecharia (`suggested_evidence`), assim autor sabe o que produzir.
- Para `confirmed_ok`: cite `evidence_ref` que verifica (pode ser outro `file:line`, comando, ou test fixture).
- Em `summary`, comece com veredicto: "solid", "needs work", ou "structural issues".

## Critérios de severidade (gaps e contradictions)

| Severidade | Definição |
|---|---|
| `critical` | Gap/contradição que torna o artefato inaplicável (spec impossível de implementar, plano internamente inconsistente) |
| `high` | Gap que vai surpreender quem implementar; contradição entre seções principais |
| `medium` | Gap em edge case; claim importante sem evidência mas consertável |
| `low` | Detalhe ausente, melhoria de clareza |

`low` quase nunca vai em `gaps` — vira `unverifiable` ou `not_checked`. Auditor que reporta 30 itens `low` está fazendo nitpick, não audit.

## Heurísticas (o que procurar)

- **Conceito introduzido sem schema/contrato.** "Tabela X é usada" sem schema declarado.
- **Cross-ref que não resolve.** `§N` ou `FOO.md §M` apontando pra inexistente.
- **Symbol mencionado sem definição.** Tool/comando/estado citado sem aparecer em outro lugar canônico.
- **Invariante declarada sem verificação.** "Sempre X" sem mecanismo que garanta X.
- **Trade-off omitido.** Decisão sem custo declarado é decisão sem ponderação.
- **Claim de "isso é seguro/correto/idempotente" sem evidência.** Vai pra `unverifiable`.
- **Numeração inconsistente após renumeração.** Comum em spec longa editada incrementalmente.

## Heurísticas de busca rápida

```bash
# Símbolo citado no artefato existe no código?
rg -nw 'cited_symbol' src/

# Cross-ref de seção (artefato cita "FOO.md §N.N" — existe?)
rg -nE '^##+\s+N\.N\b' FOO.md

# Tabela/schema mencionado bate com migrations?
rg -niE 'CREATE TABLE\s+(IF NOT EXISTS\s+)?\bclaimed_name\b' migrations/

# Numeração de seções: detectar gap ou duplicata
rg -nE '^##\s+[0-9]+\.' artifact.md | awk -F'[. ]' '{print $3}' | sort -n | uniq -c

# Cross-ref entre artefatos: linhas que mencionam outros docs
rg -nE '\b[A-Z_]+\.md\b' artifact.md
```

## Anti-pattern do próprio auditor (sycophancy)

Modelo default tende a confirmar. Sintomas:

- `confirmed_ok` longo com itens não-verificados
- Ratio `confirmed_ok / (gaps + contradictions + unverifiable)` > 3:1 sem evidência forte
- Nenhuma `unverifiable` em audit de artefato com 1000+ linhas (improvável que tudo seja checável)

Se o output parece "tudo OK", **revise** — provavelmente faltou cético.

## Quando NÃO conseguir auditar

- Artefato é prosa narrativa sem claims verificáveis (ensaio, design rationale puro): retorna `summary` reconhecendo isso + `not_checked` com motivo.
- Faltam refs externas pra verificar (artefato cita `INTERNAL_DOC.md` que você não pode acessar): vai em `unverifiable`, não em `gaps`.

## Exemplo de output mínimo

\`\`\`yaml
summary: "needs work — 2 contradictions estruturais entre STATE_MACHINE §2.3 e RECAP §3, 4 gaps de schema. Resto está sólido onde verificado."
gaps:
  - artifact_ref: "STATE_MACHINE.md §11"
    claim_or_section: "drift detector emite drift_event(...)"
    what_is_missing: "schema da tabela drift_events não declarado"
    severity: high
    why_it_matters: "consumidores (eval, /recap forensics) não sabem colunas"
contradictions:
  - artifact_ref_a: "RECAP.md §3 (linha 107)"
    artifact_ref_b: "STATE_MACHINE.md §2.3.1 (schema)"
    conflict: "RECAP define goal_stack com 6 campos; schema SQL canônico tem 9"
    severity: medium
unverifiable:
  - artifact_ref: "ORCHESTRATION.md §4.6"
    claim: "fallback estático tem latência < 50ms"
    why_unverifiable: "sem benchmark referenciado"
    suggested_evidence: "link pra evals/compaction/static_fallback/latency.json"
confirmed_ok:
  - artifact_ref: "STATE_MACHINE.md §9"
    claim: "todos eventos novos (drift_*, regrounding_*) estão na tabela"
    evidence_ref: "verificado via grep ^| em §9; 4 entries presentes"
not_checked:
  - area: "ORCHESTRATION.md §6 (self-critique)"
    reason: "fora do escopo do patch auditado"
assumptions:
  - "spec é source of truth; não verifiquei contra implementação real (não existe ainda)"
\`\`\`
```

**Eval acoplado:** `evals/playbooks/gap-audit/` com 10 fixtures:
- 4 artefatos com gaps semeados deliberadamente (esperado: `gap_recall ≥ 0.8`)
- 3 artefatos limpos (esperado: `false_positive_rate ≤ 0.05`, ou seja, `gaps[]` quase vazio)
- 3 artefatos com contradições internas semeadas (esperado: detector recall ≥ 0.7)

Métrica anti-sycophancy: **`false_confirmation_rate`** = items em `confirmed_ok` que não têm `evidence_ref` válido (resolvível) / total `confirmed_ok`. Threshold: ≤ 0.05. PR-bloqueante.

---

## 11. Playbook: `challenge-assumptions`

Slash command: `/challenge`. Subagent isolado com viés de red-team. Recebe uma decisão, plano, ou cadeia de raciocínio e ataca o **raciocínio**, não o artefato. Não propõe alternativas vencedoras; expõe o que seria preciso ser verdade para a conclusão se sustentar.

Distinto de `gap-audit` (audita **artefato textual** procurando claim sem evidência) e `code-review` (revisa **mudanças** de código). `challenge-assumptions` opera sobre **uma cadeia de raciocínio** — pode ser um parágrafo, um design doc, uma seção de PR description, uma decisão tomada em chat.

```yaml
---
name: challenge-assumptions
description: Ataca o raciocínio de uma decisão/plano/análise. Expõe premissas load-bearing, framings silenciosamente descartados e falsificadores. Não propõe alternativa vencedora.
tools: [read_file, grep, glob]
budget:
  max_steps: 20
  max_cost_usd: 0.40
references:
  - CRITICAL_THINKING.md
  - GROUPTHINK_BIAS.md
slash: challenge
when_to_use: "decisão/plano com confiança alta + evidência fraca; raciocínio que usa 'obviously', 'sempre podemos depois', ou ignora opções óbvias (não fazer nada, comprar, deprecar)"
sampling:
  temperature: 0.3                 # leve divergência pra alternativas plausíveis, não fantasia
  max_tokens: 4096
  thinking_budget: 4000
output_schema:
  summary: string                  # 1-3 linhas: verdict + headline weakness
  target:                          # o que está sendo desafiado (cite verbatim ou ref)
    - { ref, claim_or_decision }
  unverified_premises:             # asseridas como verdade, não verificadas
    - { premise, why_load_bearing, how_to_verify, severity }
  alternative_framings:            # framings descartados sem percepção
    - { alternative, why_plausible, what_changes_if_true }
  falsifiers:                      # o que precisaria ser verdade pra conclusão estar errada
    - { claim, falsifier, observable }
  confidence_gap:                  # confiança asserida > evidência apresentada
    - { claim, asserted_confidence, evidence_strength, gap }
  not_checked: [ { area, reason } ]
  assumptions: [string]            # meta-assumptions do próprio challenge
---
```

```markdown
# Challenge Assumptions

Você ataca o raciocínio de uma decisão/plano/análise.
Sua única saída é um relatório no schema acima.
Não escreve código. Não decide pelo usuário. Não propõe a "alternativa vencedora".

## NÃO faça

- NÃO faça devil's-advocacy teatral. Cada `alternative_framing` tem que ser **plausivelmente verdadeira sob alguma evidência observável** — não basta ser logicamente possível.
- NÃO faça bothsidesing. Se a decisão é dominante (uma opção ganha em todos critérios declarados), reporta isso em `summary` e enxuga `alternative_framings`.
- NÃO transforme `falsifiers` em "what if" hipotético sem constraint real. Falsificador útil é observável e ligado a evidência atual ou futura ("se latência p99 > 200ms, premissa quebra").
- NÃO desafie a conclusão atacando definição de termos. "Depende do que você chama de Y" é ruído, não challenge.
- NÃO entre em recursão — desafiar o próprio challenge até nada ser acionável. Um nível de dúvida.
- NÃO produza lista longa de premissas triviais (`assume HTTP funciona`). Premissa vai pra `unverified_premises` só se for **load-bearing** (conclusão muda se ela for falsa).
- NÃO recomende a alternativa. Só exponha que ela existe e o que mudaria.

## Faça

- Cite o `target` verbatim ou com ref (`file:line`, mensagem específica). Sem isso, virou crítica genérica.
- Para `unverified_premises`: explique **por que load-bearing** — qual passo do raciocínio cai se ela for falsa.
- Para `alternative_framings`: declare **o que muda** se a alternativa for adotada — escopo, custo, prazo, risco. Alternativa sem consequência é ornamento.
- Para `falsifiers`: dê observável concreto (métrica, comportamento, evidência futura) que decidiria a questão.
- Para `confidence_gap`: distinga "asserido com confiança alta" vs "evidência apresentada" — a lacuna é o ponto.
- Em `summary`, comece com veredicto: "solid reasoning", "load-bearing assumptions", "frame-trapped" (decidiu dentro de framing estreito), "confidence > evidence".

## Critérios de severidade (unverified_premises)

| Severidade | Definição |
|---|---|
| `critical` | Premissa cuja falsidade inverte a decisão |
| `high` | Premissa cuja falsidade muda escopo/custo materialmente |
| `medium` | Premissa cuja falsidade afeta edge case importante |
| `low` | Premissa cuja falsidade muda detalhe — quase nunca reportar; vai pra `not_checked` |

## Heurísticas (sinais de raciocínio frágil)

- **Marcadores de intuição** — "obviously", "claramente", "óbvio que", "of course". Sinaliza premissa não examinada.
- **Confiança assimétrica** — claim forte com evidência fraca ("vai escalar", "é seguro", "usuário vai gostar") sem benchmark/threat model/data.
- **Opção fantasma** — alternativa óbvia não mencionada. Especialmente: "não fazer nada", "comprar em vez de construir", "matar a feature", "voltar à versão N-1".
- **"Sempre podemos X depois"** — custo de reversão sendo ignorado. Geralmente não-trivial.
- **Falácia conjuntiva** — argumento requer N coisas verdadeiras simultaneamente; cada uma ~80%, joint << 80%. Liste os N e multiplique.
- **Anchor a um framing** — decisão entre A e B quando C existe. Frame-trap.
- **Sycophancy social** — "todos concordam", "consensus do time" (ver `GROUPTHINK_BIAS.md`). Concordância não é evidência.
- **Generalização de N=1** — "vimos isso funcionar antes" sem condições controladas.

## Anti-pattern do próprio challenger

Modelo default tende a OU concordar OU produzir contrarianismo barato. Sintomas:

- `alternative_framings` vazio em decisão não-trivial → provavelmente sycophancy.
- `alternative_framings` com 6+ alternativas, várias implausíveis → contrarian theater.
- `falsifiers` sem observável (`"se a premissa estiver errada"` ≠ falsificador).
- `confidence_gap` vazio em raciocínio que usa "obviously" — não checou.

Se o output parece "concordo no geral, mas...", **revise** — provavelmente faltou ataque real.

## Quando NÃO conseguir desafiar

- Target é trivial (decisão sem stake real, escolha estética): retorna `summary` "low-stakes, no challenge warranted" + `not_checked` honesto.
- Target já vem com análise de alternativas e falsificadores explícitos: spot-check 1-2 itens, retorna `summary` "reasoning robust where checked" + escopo em `not_checked`.
- Target é fato verificável, não decisão (ex.: "a função X retorna Y"): redirecione — esse é trabalho de `gap-audit` ou leitura direta.

## Exemplo de output mínimo

\`\`\`yaml
summary: "frame-trapped — decisão entre rewrite e refactor ignora opção 'kill feature'. Duas premissas load-bearing sem evidência."
target:
  - ref: "design_doc.md §3 (linha 42-58)"
    claim_or_decision: "vamos refatorar o módulo de billing em vez de rewrite"
unverified_premises:
  - premise: "código atual de billing é >70% reusável"
    why_load_bearing: "se < 50% reusável, refactor custa mais que rewrite — inverte decisão"
    how_to_verify: "rodar análise de complexidade ciclomática + identificar dead code"
    severity: critical
  - premise: "feature continua relevante nos próximos 18 meses"
    why_load_bearing: "ambas opções pressupõem que vale o investimento"
    how_to_verify: "revisar roadmap + churn de billing nos últimos 6 meses"
    severity: high
alternative_framings:
  - alternative: "deprecar feature e migrar usuários pra integração externa (Stripe Billing)"
    why_plausible: "doc menciona que 80% dos casos de uso já cabem em Stripe nativo"
    what_changes_if_true: "elimina ambos refactor e rewrite; esforço vira migração + comunicação"
falsifiers:
  - claim: "refactor é mais barato que rewrite"
    falsifier: "se métrica de cobertura de testes < 40%, refactor sem rede de segurança custa mais"
    observable: "coverage report do módulo billing"
confidence_gap:
  - claim: "código é mantível"
    asserted_confidence: "alta (palavra 'sólido' no doc)"
    evidence_strength: "nenhuma — sem métrica, sem review citado"
    gap: "asserção forte sem evidência"
not_checked:
  - area: "custo de migração assumindo opção 'deprecar'"
    reason: "fora do escopo; só sinalizando que opção existe"
assumptions:
  - "tratei design_doc.md como completo; pode haver análise em outro lugar não referenciado"
\`\`\`
```

**Eval acoplado:** `evals/playbooks/challenge-assumptions/` com fixtures:
- 3 decisões com framing estreito deliberado (esperado: detector recall de `alternative_framings` ≥ 0.7)
- 3 decisões com premissa load-bearing semeada (esperado: aparece em `unverified_premises` com severity ≥ high)
- 2 decisões robustas (alternativas e falsificadores já explícitos) — esperado: `summary` reconhece + `alternative_framings` curto
- 2 decisões triviais — esperado: retorna "low-stakes" sem inflar output

Métrica anti-contrarian-theater: **`implausible_alternative_rate`** = `alternative_framings` que não passam em revisão humana de plausibilidade / total. Threshold: ≤ 0.15. PR-bloqueante.

---

## 12. Distribuição inicial via `agent init`

Os 10 playbooks canônicos listados em §2-§11 ficam empacotados no binário e são distribuídos via `agent init` (`AGENTIC_CLI.md §2.1`). Em `init` numa árvore sem `.agent/agents/`, cada playbook é copiado pra lá em formato `.md` — o mesmo formato que o loader de subagents lê depois. O scaffold é **idempotente por arquivo**: passos seguintes pulam playbooks já existentes (operador pode ter editado um), e `--force` (ou `--force=playbooks`) sobrescreve cada `.md` mesmo que tenha mudado.

Granularidade:

- `agent init` — scaffolda os 4 artefatos do bootstrap (`permissions.yaml`, `.gitignore`, `config.toml`, playbooks) numa só invocação.
- `agent init --only=playbooks` — re-copia só os playbooks (ex: após `git pull` que trouxe versão nova do binário, ou após apagar `.agent/agents/` manualmente).
- `agent init --force=playbooks` — sobrescreve os 10 mesmo que o operador tenha editado. Use quando quer descartar customizações e voltar ao baseline canônico.

**Customizações continuam disjuntas do scaffold.** Playbooks per-developer ficam em `~/.config/agent/playbooks/`; playbooks per-projeto customizados ficam em `.agent/agents/` mas com nomes que não colidem com os 10 canônicos (o scaffold só toca arquivos cujo `filename` aparece em `src/cli/init-playbooks/index.ts`). Se o operador renomear um canônico (`code-review.md` → `code-review-strict.md`) o original re-aparece no próximo `init` — sintoma esperado; o scaffold não rastreia renames.

**Distribuição vs. discovery.** A discovery de playbook (system prompt injetado, listagem via `/`) lê de `~/.config/agent/playbooks/` + `.agent/agents/` independente de quem escreveu — `agent init` é só o mecanismo que coloca os 10 canônicos no diretório certo na primeira vez. Operador que prefere bootstrap manual pode pular o `--only=playbooks` e copiar à mão.

---

## 13. Como adicionar um playbook novo

1. Criar `~/.config/agent/playbooks/<name>.md` com frontmatter completo.
2. Definir output schema com `summary` + `assumptions` + `not_checked` (mínimo).
3. Escrever **constraints negativas primeiro** ("NÃO faça"), positivas só onde não óbvio.
4. Apontar `references` em vez de embarcar conteúdo.
5. Criar fixture de eval em `evals/playbooks/<name>.yaml` antes de usar em produção.
6. Rodar smoke eval. Iterar até passar.
7. Só então registrar em `slash:` pra ficar disponível em `/`.

Sem (5)-(6), o playbook regride silenciosamente quando o prompt do system mudar.

---

## 14. Anti-patterns comuns (não cometa)

| Anti-pattern | Por que é ruim |
|---|---|
| `Você é um engenheiro sênior...` | Role-play não melhora output, só polui contexto |
| `Pense passo a passo: 1... 2... 3...` | Force-decomposition degrada modelos modernos em tarefa simples |
| Embarcar `OPSEC.md` inteira no prompt | Token bloat; carrega coisa irrelevante; cache trash |
| Playbook sem output schema | Output vira prosa livre; impossível de eval |
| Schema sem `not_checked`/`assumptions` | Perde honestidade epistêmica; modelo finge cobertura |
| Permitir `edit_file` em playbook de review/audit | Modelo "ajuda" e quebra escopo |
| Playbook que faz duas coisas (ex: review + fix) | Cada uma rendida pior; faça dois playbooks |
| 50 instruções positivas, 0 negativas | Modelo pondera; diluição mata sinal |
| Sem eval | Regride no próximo refactor de system prompt |

---

## 15. Playbooks futuros (candidatos)

Ordem de retorno esperado. Teto recomendado: **6 playbooks total**. Mais que isso o modelo confunde a seleção. **Atual: 5** — dentro do teto. Gatilho de revisão: eval de slash command selection mostra confusão > 5% em sessões recentes → revisitar. Deprecar um playbook ativo exige PR de remoção (já foram `git-hygiene`, `debug`, `refactor`, `explain`, `threat-model`).

Atual (5): `code-review`, `security-audit`, `perf-investigate`, `gap-audit`, `challenge-assumptions`. (`git-hygiene` removido em 2026-06-13; `debug`/`refactor`/`explain`/`threat-model` removidos em 2026-06-13 — diagnóstico, refactor, explicação e threat modeling voltam ao modo normal. Ver tombstones §4–§7 e §9.)

Os dois meta-playbooks (`gap-audit`, `challenge-assumptions`) operam sobre input não-código e formam um par complementar: `gap-audit` ataca **artefato** (claim vs evidência), `challenge-assumptions` ataca **raciocínio** (premissa load-bearing, framing estreito, falácia conjuntiva). São primitivas canônicas anti-sycophancy / anti-frame-trap reusáveis (audit de spec, plano, PR description, decisão em chat, threat model com schema unificado).

| Candidato | Quando fazer | Por quê |
|---|---|---|
| `incident-response` | quando útil em on-call | Estabiliza → diagnostica → comunica. Mindset distinto de debugging ad-hoc. Ref: `INCIDENT_RESPONSE.md`, `PROD_PROBLEM.md`, `OBSERVABILITY.md`. |
| `test-add` | se cobertura é prioridade | Adiciona testes pra função/módulo. Ref: `TESTS.md`. |
| `api-design` | se workflow é design de API | Endpoint design com constraints. Ref: `API_DESIGN.md`, `DESIGN_CONTRACT.md`. |
| `architect` | provavelmente nunca | Vira filosofia; modelo já é bom em design quando contexto é bom |
| `pair-coding` | nunca | Modo default já é isso |

Princípio: cada playbook novo só entra se **eval mostra que modo normal falha** no workflow. Sem evidência empírica, fica em backlog. Promoção de `perf-investigate` é decisão de design; eval-driven validation segue.

---

## 16. Insight final

Playbook bem feito não ensina o modelo a pensar — **restringe** o que ele pode fazer e **estrutura** o que ele deve devolver. O resto é o modelo já fazendo o trabalho dele.

Quem confunde "instruir o agente a pensar como engenheiro" com "dar tools certas + schema certo + constraints certas" vai escrever 5 mil palavras de prompt e ficar pior que quem escreveu 200 com schema bom.

Menos voz. Mais trilho.
