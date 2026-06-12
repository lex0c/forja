# WORKING_STATE

Painel operacional do agente: um estado **pequeno, mutável e descartável** que
responde, a cada step, às quatro perguntas que o modelo hoje re-infere do
histórico cru — *o que estou fazendo? qual hipótese está ativa? qual o próximo
passo? o que já rejeitei?*

Não é memória, não é resumo de sessão, não é fonte de verdade histórica. É o
**instrumento de bordo** do turno corrente: lido de graça (injetado no prompt,
§5) e atualizado barato (uma tool parcial, §4). A fonte histórica continua sendo
`messages` / `tool_calls` / audit ([`AUDIT.md`](./AUDIT.md)).

> **Premissa-raiz (`CLAUDE.md`):** "meça duas vezes, corte uma". O working-state
> materializa a primeira metade — manter explícito *o que se está medindo e por
> quê* — sem virar a "segunda conversa" que o §0 proíbe. A revalidação antes do
> corte (drift detector, [`ORCHESTRATION.md §11`](./ORCHESTRATION.md)) consome
> este estado como sinal, mas é subsistema **separado e fora do escopo** deste
> doc (ver §6.3).

---

## 0. Princípios (não-negociáveis)

1. **Painel, não diário.** Working-state é estado operacional **temporário**, não
   memória ([`MEMORY.md`](./MEMORY.md)) nem recap ([`RECAP.md`](./RECAP.md)).
   Nunca é consultado como registro do que aconteceu.

2. **Bounded-hot-state, não append-only.** Só o audit log é append-only. O
   working-state é agressivamente pequeno e se **auto-descarta** (§3). O custo de
   contexto é **plano**: `O(1)` no tamanho da sessão, não `O(steps)`. Um painel
   que cresce com a sessão recria a degradação que ele deveria matar.

3. **Read grátis, update barato.** O estado é injetado a cada step (§5), então o
   modelo nunca o *lê* via tool — ele já o vê. Sobra **uma** operação:
   `working_state_update` (§4), parcial e permissiva. Se atualizar custar
   cerimônia, o modelo para de atualizar e o painel vira **mentira compacta**.

4. **O store faz a contabilidade, não o modelo.** Mover hipótese resolvida pro
   log, cortar o FIFO, evictar a mais stale, avisar de overflow — tudo é trabalho
   do store. O modelo declara intenção; o store mantém os invariantes.

5. **In-memory, session-scoped, descartável.** Vive em processo, morre no fim da
   sessão — como `TodoStore` (`src/todo/index.ts`) e o inbox
   ([`ORCHESTRATION.md §3B.1`](./ORCHESTRATION.md)). **Sem tabela, sem migration,
   sem persistência.** Resume **não** re-hidrata: audit/recap seguem como verdade
   e o modelo reconstrói o painel conforme trabalha (§7.4).

6. **Nunca fonte de verdade histórica.** Se um item cai do FIFO ou é evictado,
   nada se perde: a tool foi chamada, o resultado está em `tool_calls`. O
   working-state é **cache quente**, não o livro-razão.

---

## 1. A degradação que ataca

Sessões longas degradam menos por tamanho e mais por **estado operacional
incorreto ou perdido**. Uma das causas nomeadas é o modelo **perder o fio
operacional**: depois de 20 descobertas e 5 sub-tarefas, "qual era o objetivo
mesmo?", "qual hipótese estávamos testando?", "isso eu já tentei?" só são
recuperáveis relendo o histórico inteiro — caro, e a cada compaction o resumo
re-deriva tudo do zero (o anti-pattern `summary_v1 → v2 → v3`).

O working-state extrai esse fio do histórico e o materializa como **estado vivo
e estável**, fora da conversa, sempre presente no prompt.

### 1.1 É uma peça, não a solução inteira

Working-state ataca **só** a perda de fio operacional — uma fração da degradação
de sessão longa. As outras peças do conjunto já existem ou estão especificadas
na Forja, e o working-state **não as substitui**:

| Causa de degradação | Mitigação | Onde |
|---|---|---|
| Tool output bruto | summarize per-tool | [`OUTPUT_POLICY.md`](./OUTPUT_POLICY.md), `src/tools/output-summarizer.ts` |
| Contexto irrelevante | relevance-elide pré-compaction | [`CONTEXT_TUNING.md §12.1`](./CONTEXT_TUNING.md), `src/harness/compaction-relevance.ts` |
| Compaction sob pressão | gatilho a 70%, não 100% | [`CONTEXT_TUNING.md §3`](./CONTEXT_TUNING.md) |
| **Fio operacional perdido** | **working-state** | **este doc** |
| Hipótese errada persistente | drift detector (revalidação) | [`ORCHESTRATION.md §11`](./ORCHESTRATION.md) — consome §6.3 |

### 1.2 Relação com `TodoStore`

O working-state **não** absorve nem substitui o `TodoStore` (`todo_*`,
[`CONTEXT_TUNING.md §10.4`](./CONTEXT_TUNING.md)). A divisão:

- **`TodoStore`** = a lista de tarefas **formal**: itens discretos com status
  (`pending`/`in_progress`/`done`), no máximo um `in_progress`, renderizada na
  TUI. Responde *"quais tarefas e em que estado"*.
- **`working_state.next`** = o fio **leve** de próximos passos imediatos. Quando
  a lista cresce além de uns poucos passos, isso **é** um plano e pertence ao
  `TodoStore` (§3 trata o overflow exatamente assim).

Os dois coexistem; nenhum deriva do outro.

---

## 2. Modelo de dados

In-memory. Sem schema SQL — espelha a forma do `TodoStore`: um `Map` por
`sessionId`, possuído pela harness, entregue às tools via `ToolContext`.

```ts
interface WorkingState {
  // O que estou fazendo agora. 1 linha. SET (sobrescreve). Carimba o step.
  focus?: { text: string; atStep: number };

  // Próximos passos imediatos. SET (a lista inteira é substituída a cada update).
  next: string[];

  // Marcos curtos em ordem cronológica. APPEND + FIFO. Não editável, não removível.
  log: WorkingLogEntry[];

  // Crenças em verificação. ADD + transição de status. confirmed/refuted saem
  // da lista ativa e viram log (§4.2).
  hypotheses: Hypothesis[];
}

interface WorkingLogEntry {
  text: string;     // ≤ 200 chars
  atStep: number;   // step em que entrou (render de recência + FIFO determinístico)
}

interface Hypothesis {
  id: string;                                   // estável na sessão, nunca reciclado
  text: string;                                 // ≤ 200 chars
  status: "open" | "confirmed" | "refuted";
  source: "user" | "model" | "tool";            // quem originou a crença (default model; §2.1)
  evidence: string[];                           // ponteiros, não cópias; ≤ 5 itens
  updatedAtStep: number;                        // staleness = stepAtual − updatedAtStep (§6)
}
```

**Decisão de design — sem `confidence`.** Um score numérico (`0.4`, `0.7`) em
estado operacional é *fake precision*: ninguém calibra 0.4 vs 0.6, e o número
vira numerologia. `status` + `evidence` + `staleness` (idade em steps) carregam o
mesmo sinal — "esta crença é velha, sem evidência nova, e ninguém a confirmou" —
sem o teatro. Eviction e priorização usam **staleness**, não confidence (§3, §6).

### 2.1 Owner (`source`)

Cada hypothesis carrega **quem a originou**: `user` (o operador afirmou), `model`
(o agente formou) ou `tool` (derivada de um output). Default `model` — o caso
comum. A distinção é barata e importa na hora de questionar: **uma crença que o
operador afirmou tem peso diferente de um chute do modelo.** Refutar uma
`user`-hypothesis não é rotina — passa por `clarify` (confirmar com o operador
antes de descartar o que ele afirmou); refutar uma `model`-hypothesis é o ciclo
normal. Renderizada inline (§5.4) pra que o peso fique visível sem consulta.

---

## 3. Disciplina por slot

A regra: **o eixo de descarte reflete a semântica do slot.** Nenhum slot cresce
com a sessão.

| Slot | Update | Cap (contagem) | Cap (por item) | No estouro |
|---|---|---|---|---|
| `focus` | set | 1 | ≤ 120 chars | nunca acumula (sobrescreve) |
| `next` | set | ≤ 5 | ≤ 120 chars | guarda 5, avisa: *"o resto é plano → `todo_create`"* |
| `log` | append | ≤ 15 | ≤ 200 chars | **FIFO**: a 1ª sai (idade); render por janela §5.5 |
| `hypotheses` (ativas) | add + status | ≤ 7 `open` | text ≤ 200, evidence ≤ 5 | evicta a de maior **staleness** → vira 1 linha de log |
| **global renderizado** | — | **2–4 KB** | — | salvaguarda final: apara `log` primeiro, depois `evidence` |

Os quatro eixos:

- **`focus` — não acumula.** Sempre 1 linha; o custo é fixo. Só carrega idade
  (§6) pra sinalizar foco velho.
- **`next` — descarte por foco.** O cap de 5 é uma *força de design*, não de
  memória: empurra a lista grande pro lugar certo (`TodoStore`). Estourou → o
  `tool_result` diz o que sobrou e sugere `todo_create`.
- **`log` — descarte por idade.** FIFO puro. É memória de curtíssimo prazo do
  "que fiz recentemente"; o registro permanente é o audit. FIFO cego é seguro
  porque o que precisa durar tem válvula de escape (ver "hierarquia" abaixo).
- **`hypotheses` — descarte por irrelevância.** O cap conta só as `open` — quantas
  crenças **não-verificadas** se carrega ao mesmo tempo (perseguir 10 hipóteses
  paralelas é o problema, não a solução). Estouro **não** é FIFO: sai a de maior
  staleness (a crença mais esquecida), não a mais antiga por acaso. `confirmed` e
  `refuted` já saem sozinhas da lista ativa (§4.2).

### 3.1 Hierarquia de durabilidade (por que o FIFO é seguro)

O que precisa durar **além** do FIFO não vive no `log` — sobe na hierarquia que
já existe:

| Dura | Vive em |
|---|---|
| 1 turn | a conversa |
| a sessão, curto prazo | `working_state.log` (FIFO) |
| a sessão, invariante | **pin** (`context_pins`, never-elided — `CONTEXT_TUNING.md §12.4`) |
| além da sessão | **memory** (governance, cross-session — `MEMORY.md`) |

Uma descoberta importante que envelheceria fora do FIFO deve virar pin ou memory
— não esperar que o `log` a preserve.

---

## 4. Tool: `working_state_update`

Uma tool, patch parcial, permissiva. Todos os campos são opcionais; uma chamada
atualiza só o que mudou.

```ts
working_state_update({
  focus?: string,                 // set; "" limpa
  next?: string[],                // set (substitui a lista inteira)
  logAppend?: string[],           // append ao log (cada um vira WorkingLogEntry)
  hypothesisAdd?: { text: string, source?: "user" | "model" | "tool" },  // source default model; retorna o id
  hypothesisUpdate?: {
    id: string,
    status?: "open" | "confirmed" | "refuted",
    evidenceAppend?: string[],
  },
})
```

### 4.0 Quando atualizar (o gatilho)

O maior risco do working-state **não é técnico, é comportamental**: a tool existe
e o modelo esquece de usá-la → painel fantasma. O contra-nudge vive na
**description da tool** (cache breakpoint #2, custo zero por step) e reforçado no
system prompt:

> *"When your focus, active hypothesis, or next steps materially change, update
> the working state."*

O **"materially"** é deliberado: equilibra os dois fracassos opostos — o fantasma
(nunca atualiza) e o spam (atualiza cada micro-passo, recriando a "segunda
conversa" que o §0 proíbe). O gatilho é mudança de *estado operacional*, não
registro de cada ação. A taxa de mutação saudável é, ela própria, um sinal de
eval (§4.4, §9): nem ~0, nem altíssima.

### 4.1 Contrato (rubrica `CONTRACTS.md §2.6`)

- **Determinístico**: mesmo patch + mesmo estado ⇒ mesmo resultado.
- **Idempotência**: `focus`/`next` são naturalmente idempotentes (set).
  `logAppend`/`hypothesisAdd` **não** são (cada chamada acrescenta) — declarado.
- **Side-effects**: muta o working-state in-memory da sessão. **Reversível** no
  sentido prático (descartável; nada persiste fora do audit do `tool_call`).
- **Failure as data**: `id` inexistente em `hypothesisUpdate` →
  `error_code: not_found` (não silencioso). Item acima do cap por-item →
  truncado com aviso no `tool_result`, não erro.
- **Custo**: trivial (operação em memória).

### 4.2 O store faz o trabalho

Comportamentos que mantêm o "update barato" — o modelo nunca executa cerimônia:

- marcar `status: confirmed | refuted` → o store **move** a hypothesis pra fora
  da lista ativa e escreve 1 linha no `log` (`H3 confirmed: …`). Uma op, não duas.
- `hypothesisAdd` com 7 já abertas → evicta a de maior staleness, com log
  `archived (stale): H1 — 40 steps`.
- `next` com > 5 itens → guarda os 5 primeiros, devolve no `tool_result` os que
  sobraram + sugestão `todo_create`.
- `logAppend` estourando 15 → FIFO corta os mais antigos.
- render global > teto → apara `log`, depois `evidence`.

Todo `tool_result` ecoa o estado resultante compacto, pra o modelo confirmar o
efeito sem um read.

### 4.3 Disponibilidade

- **Builtin sempre-disponível, sem permission gate** — é estado interno
  reversível, como os `todo_*` e `clarify`. Não há trust/sandbox a aplicar.
- A **chamada** é registrada em `tool_calls` como qualquer tool (rastreabilidade
  barata das atualizações), embora o **estado** não persista.
- Disponível na sessão raiz (REPL). Subagents começam com working-state vazio e
  têm a tool, mas não herdam o painel do pai (§7.3).

### 4.4 Instrumentação

Cada chamada já é um `tool_call` auditado (§4.3), e o tipo de mutação está nos
args — então as métricas de uso são **projetáveis do audit**, sem contador
persistido novo (deriva o derivável, como o recap deriva decisions de approvals).
O store mantém só um contador **in-memory** leve por tipo de mutação, pra
dashboard ao vivo, e emite um evento `working_state:update` (espelha
`todo_updated`) pra TUI/telemetria:

```
working state updates: 48
  focus changes:        12
  hypothesis created:     7
  hypothesis confirmed:   4
  hypothesis refuted:     2
```

São ouro pra eval (§9): mutation rate perto de zero delata painel fantasma; alto
demais delata spam (cf. §4.0). A faixa saudável é intermediária, calibrada por
eval.

---

## 5. Injeção no prompt

### 5.1 Posição: `[current_turn]`, bottom

O `[working_state]` entra no **fundo** do prompt, dentro do `[current_turn]`,
logo após o goal re-injection e os pins
([`CONTEXT_TUNING.md §10.2`](./CONTEXT_TUNING.md) /
[`§12.4.3`](./CONTEXT_TUNING.md)) — a zona de **máxima atenção** ("lost in the
middle", `CONTEXT_TUNING.md §8`), onde já vivem as âncoras operacionais.

### 5.2 Por que é cache-neutro

O `[current_turn]` é **reconstruído a cada step** — não há cache breakpoint
depois dele (`CONTEXT_TUNING.md §2`). Logo, um bloco que muda quase todo step
**não custa cache extra** ali: o turno já não era cacheado. Qualquer outra
posição (acima de um dos breakpoints `#1–#4`) re-invalidaria o prefixo estável a
cada turn — e cache é o gargalo de custo dominante da Forja. **Bottom do
current_turn é o único lugar correto.**

### 5.3 Frequência: todo step

Diferente do goal re-injection (que economiza re-injetando a cada 5 steps —
`CONTEXT_TUNING.md §10.1`), o working-state é injetado **a cada step**: o ponto
da feature é o painel estar *sempre* visível. O custo é bounded (≤ 2–4 KB ≈
500–1000 tokens) e cache-neutro (§5.2). **Trade-off honesto:** são ~750 tokens de
input fresco por step; é o preço de não degradar, e é ruído perto do custo de
cache-read/write do histórico de tool results.

### 5.4 Formato

```
[working_state]
focus: investigar o resolver de glob no permission engine (s.184, 6 steps atrás)
next:
  - gatear cada path no engine
  - testar most-restrictive-wins
hypotheses (open):
  - H2 (model, 12 steps): bug está no resolver de glob, não no matcher
      evidence: engine.ts:798 extrai só 1 path; repro em /run/media
  - H1 (user, 40 steps): protected-path deve respeitar o carve-out /run/media
recent log (últimos ~10 steps; mais novo embaixo):
  - [s.180] repro confirmado em /run/media
  - [s.184] engine.ts:798 — checkPath extrai 1 path só
```

A idade em steps de `focus` e cada `hypothesis` é renderizada inline — foco ou
crença velhos ficam **visivelmente** velhos, o que combate a "mentira compacta"
sem nenhum mecanismo extra.

### 5.5 Log: render por janela de recência

`focus`, `next` e `hypotheses` são injetados **sempre**. O `log` — o slot que vira
ruído primeiro — é injetado **só nas entries dos últimos `W` steps** (janela de
recência, default `W ≈ 10`), não as 15 inteiras. Sessão que andou rápido desde o
último marco mostra `log` curto ou vazio; o store segue mantendo o FIFO ≤ 15 como
buffer.

E o marco **antigo que ainda sustenta uma crença viva**? Não depende do log: ele
vive em `hypothesis.evidence`, que é sempre injetado. Isso cobre o "log
referenciado por hypothesis" **sem** um cross-link `log`↔`hypothesis` — a
evidência já é o lugar canônico de um fato que importa o bastante pra ancorar uma
crença. O log fica livre pra ser só recência pura.

---

## 6. Staleness

### 6.1 Medida em steps, não em tempo

`staleness(x) = stepAtual − x.atStep`, onde o step é o índice monotônico do step
corrente da sessão (step state machine, [`STATE_MACHINE.md §3`](./STATE_MACHINE.md)).
Steps, não wall-clock: o que importa é *quantas decisões se passaram* sem
revisitar a crença, não quantos minutos.

### 6.2 Usos

- **Render**: idade inline (§5.4).
- **Eviction de hypothesis**: ao exceder 7 abertas, sai a de maior staleness (§3).
- **`focus` velho**: nunca evictado (é sempre 1), mas a idade renderizada sinaliza
  que o modelo pode estar à deriva.

### 6.3 Gancho futuro: drift detector (fora de escopo)

O drift detector ([`ORCHESTRATION.md §11`](./ORCHESTRATION.md), especificado,
nunca implementado) revalida ações com `writes: true` antes de executar. Hoje ele
compararia a intenção apenas contra `goal.text` — sinal fraco. Com o
working-state, ele ganha o alvo certo: a **hypothesis ativa + staleness +
evidence**, sinal estruturado e barato (vs. re-inferir da conversa crua). Essa
sinergia é a justificativa de mencionar a §11 aqui — mas a §11 é **fatia
separada** e **não** faz parte desta. O working-state vale sozinho (estado
passivo); o drift é um gate ativo construído depois.

---

## 7. Lifecycle

### 7.1 Criação
Lazy: o `Map` não cria entrada até a primeira escrita (sessão que nunca chama a
tool não deixa rastro), igual ao `TodoStore`.

### 7.2 Fim de sessão
`clear(sessionId)` no session-end hook da harness — mesma fiação do `TodoStore`.
Nada sobrevive.

### 7.3 Subagents
Cada subagent é sessão própria: começa com working-state **vazio** e não herda o
do pai. Subagents são curtos e focados; o painel do pai não é contexto deles.

### 7.4 Resume
Working-state é descartável → resume **não** o re-hidrata (ao contrário de pins e
das últimas decisões, que entram no auto-rehydrate de
[`STATE_MACHINE.md §7.6`](./STATE_MACHINE.md)). O audit/recap seguem como verdade;
o modelo reconstrói o painel conforme retoma o trabalho. Re-semear o `focus` a
partir do recap é possível no futuro, mas **não** neste corte.

### 7.5 Fiação (dois caminhos)
O store é entregue via `ToolContext` em **`run.ts` e `repl.ts`** — os dois
consumidores que espelham o loop. Esquecer um deixa a tool morta nesse caminho
(precedente: o gap de spawn de subagent). O `clear` é chamado no fim em ambos.

---

## 8. Fronteiras (o que NÃO é)

| | Durabilidade | Escopo | Confirmação | Fonte histórica? | Propósito |
|---|---|---|---|---|---|
| **working_state** | in-memory, descartável | sessão | nenhuma | **não** | painel operacional do agora |
| `TodoStore` | in-memory | sessão | nenhuma | não | lista de tarefas formal |
| `context_pins` | SQLite, audit 90d | sessão | modal (§12.4) | parcial | constraints invioláveis |
| memory | on-disk + governance | cross-session | modal | parcial | conhecimento que persiste |
| recap | projeção do audit | sessão | — | **é projeção da fonte** | sumário pós-hoc |

Em uma linha: **recap projeta do audit; working-state é cache quente do agora;
nenhum dos dois é a verdade — o audit é.**

---

## 9. Eval (load-bearing)

Princípio 4: subsistema sem eval não ship. O working-state precisa **provar** que
reduz degradação, não só parecer organizado.

### 9.1 Eval implementado: o estado sobrevive à compaction

`evals/regression/51-working-state-survives-compaction.yaml` (espelha
`24-compaction-preserves-goal`): o modelo registra uma hypothesis via
`working_state_update`, lê arquivos suficientes pra **disparar compaction** (que
apaga a conversa inicial, incluindo aquela tool call), e no final reporta a
hypothesis verbatim. O token-marcador só pode reaparecer pela **re-injeção do
painel** — ele vem do store, não da conversa comprimida. Asserções:
`working_state_update` chamado, compaction disparada, marcador no output final,
run `done`. Prova a tese central — **o estado operacional persiste onde a
conversa não persiste** — com modelo real, dentro do runner declarativo
existente.

### 9.2 Eval-alvo aspiracional: degradação A/B (follow-up)

O eval que mede a *redução de degradação* diretamente — sessão longa onde uma
hypothesis registrada no step ~20 é **refutada** e, no step ~200, o agente **não
age mais** sobre ela, medido **com vs. sem** o painel — precisa de infraestrutura
que o runner declarativo atual NÃO tem: comparação A/B na mesma semente,
observação do working-state final, e sessões de centenas de steps. As métricas
que ele mediria:

- **ações sobre crença morta**: o agente ainda propõe edits coerentes com a
  hypothesis refutada? (alvo: ~0 com o painel).
- **re-pergunta / re-descoberta**: re-execução de buscas cujo resultado já estava
  no `log`/`hypotheses`.
- **mutation rate** (§4.4): updates por turn + breakdown (focus / created /
  confirmed / refuted). É a métrica **comportamental** — perto de zero delata
  painel fantasma; altíssima delata spam; saúde no meio. É o sinal mais
  importante: o working-state só paga aluguel se o modelo de fato o mantém.
- **custo**: tokens de input por step do bloco (≤ teto, não cresce com a sessão —
  valida o `O(1)`).

Fica registrado como follow-up até existir um A/B harness de eval.

Os caps (`1 / 5 / 15 / 7`, global `2–4 KB`, janela de log `W ≈ 10`) são **pontos
de partida**, tunáveis por estes evals, não constantes sagradas.

---

## 10. Cross-references

- [`CONTEXT_TUNING.md §2`](./CONTEXT_TUNING.md) — layout fixo e cache breakpoints
  (posição §5).
- [`CONTEXT_TUNING.md §10`](./CONTEXT_TUNING.md) — goal re-injection (vizinho no
  bottom).
- [`CONTEXT_TUNING.md §12.4`](./CONTEXT_TUNING.md) — pinned context (a primitiva
  durável que contrasta; a válvula de escape §3.1).
- [`STATE_MACHINE.md §3`](./STATE_MACHINE.md) — step machine (fonte do step §6).
- [`ORCHESTRATION.md §11`](./ORCHESTRATION.md) — drift detector (consumidor
  futuro §6.3).
- [`OUTPUT_POLICY.md`](./OUTPUT_POLICY.md), [`RECAP.md`](./RECAP.md),
  [`MEMORY.md`](./MEMORY.md) — peças vizinhas do conjunto (§1.1, §8).
- `src/todo/index.ts` — o store-modelo a espelhar.
