# UI

Spec da camada de interface terminal do `AGENTIC_CLI`. Modelo inline, event bus, render funcional, microcopy, headless, fallbacks.

UI ruim mata adoção mais rápido que arquitetura ruim. Arquitetura ruim você sente em 6 meses. UI ruim você sente em 30 segundos.

> Modelo: **inline rendering**, sem alt-screen, sem framework. Histórico vai pro scrollback do terminal; região viva no fundo redesenha em cada frame.

---

## 0. Princípios (não-negociáveis)

1. **Inline > alt-screen.** Output normal vai pro stdout e rola com o scrollback do terminal. Copy-paste, mouse-scroll, redirecionamento, Ctrl+C — tudo funciona sem código. Alt-screen quebra esses comportamentos e exige reimplementar scrollback.
2. **Sem framework.** Zero React/Ink/blessed. A região viva tem 3-15 linhas; clear+redraw é mais rápido que reconciliação. Ver `ANTI_PATTERNS.md`.
3. **Event bus tipado é a espinha dorsal.** Harness emite eventos (§3); renderer escuta e atualiza a região viva. Mesmo bus alimenta `--json` (NDJSON em stdout) e testes (assert sobre eventos).
4. **Render funcional.** Cada elemento (`tool card`, `todo list`, `permission modal`) é uma função pura `render(state): string[]`. Sem ciclo de vida, sem props, sem hooks.
5. **stdout é sagrado.** Histórico (mensagens completas, tool cards finalizados) vai pra stdout permanente — vira scrollback. Região viva escreve no mesmo stdout mas se "apaga" antes de cada redraw. `stderr` é só log estruturado.
6. **Microcopy importa tanto quanto código.** "Algo deu errado" é bug. "Tool `bash` excedeu 30s; output abaixo, decisão sua" é UX.
7. **Inputs do humano são sagrados.** Nunca perdê-los. Nunca duplicá-los. Nunca pisotear o cursor durante digitação.
8. **Modal nunca surpreende.** Permission/trust/memory write sempre tem precedente lógico. Se não tem, é bug de arquitetura.
9. **Quebra graciosamente.** Sem TTY, sem cor, sem Unicode → degrada (texto puro, ASCII glyphs). Nunca morre.
10. **Reversibilidade visível.** Se algo é desfazível, a UI mostra (`Ctrl+Z` disponível, último checkpoint, etc.).
11. **Vocabulário técnico, sem fluff.** O usuário-alvo é engenheiro. Verbos descrevem a ação real (`Generating`, `Reading`, `Executing`), não rótulos genéricos (`Working`, `Loading`). Sem cortesia (`Please wait…`), sem mascote, sem metáfora. Detalhe operacional concreto (duração, tokens, paths) sempre que cabe em uma linha. Ver §4.10.

---

## 1. Stack

```jsonc
{
  // utilitários pontuais (NÃO framework)
  "string-width": "7.x",   // largura visual de strings com unicode/CJK/emoji
  "wrap-ansi": "9.x"       // quebra de linha ANSI-aware
}
```

Capability detection é manual e pequena (~30 linhas — `process.stdout.isTTY`, `NO_COLOR`, `TERM`, `LANG`/locale para Unicode). Sem deps de detecção.

**Regras:**
- Adicionar dep nova requer justificativa (substitui o quê? cobre quanto código?).
- `picocolors`/`chalk`/`kleur` proibidos: cor é gerada por escape codes inline (~5 helpers).
- `cli-spinners`/`ora` proibidos: spinner é trivial (§5.2).
- `prompts`/`inquirer` proibidos: input é nosso (§5.1).

---

## 2. Modelo de tela (inline)

A tela tem **duas zonas, uma temporal e outra espacial**:

```
─── scrollback (terminal nativo) ──────────────────────
  [permanente] user message
  [permanente] tool card finalizado
  [permanente] assistant message
  [permanente] tool card finalizado
─── região viva (últimas 3-15 linhas, redesenhada) ────
  [vivo] tool em execução / spinner
  [vivo] todo list ativa (se houver)
  [vivo] status line (steps · cost · model · mem · bg)
  [vivo] input box
─── cursor ───────────────────────────────────────────
```

### 2.1 Conteúdo permanente (scrollback)

Sai do `stdout` via `printPermanent(lines: string[])`. Uma vez impresso, **nunca é redesenhado**. Vira parte do scrollback do terminal — copia, busca, mouse-scroll funcionam.

Vai pra scrollback:
- Mensagens do usuário (echo após submit).
- Mensagens completas do assistant (após `assistant:end`).
- Tool cards no estado final (após `tool:end`).
- Cabeçalhos de sessão e separadores discretos.

### 2.2 Conteúdo vivo (região no fundo)

Reside em memória como `LiveState`. A cada mudança (evento do bus ou tick de spinner), o renderer:

1. Move cursor: `\x1b[<n>A` (sobe N linhas, N = altura do último frame).
2. Limpa: `\x1b[J` (apaga do cursor pra baixo).
3. Compõe `string[]` via funções de render.
4. Escreve em uma única `process.stdout.write(...)`, envelopada em **synchronized output** (DECSET 2026): `\x1b[?2026h` no início + `\x1b[?2026l` no fim. Terminais que suportam (kitty, iTerm2, alacritty, wezterm, recent gnome-terminal/konsole) bufferam o conteúdo entre BSU/ESU e renderizam como **frame atômico** — sem o flicker de "cursor-up + clear → conteúdo" sendo pintado em passos visíveis. Terminais sem suporte ignoram (modo privado, comportamento spec-compliant). Aplica-se também ao path permanente (erase + scrollback line + draw): a transição inteira é uma frame.
5. Reposiciona cursor dentro do input.

Frame budget: **30fps soft, 60fps em bursts** (ver `PERFORMANCE.md`). Coalescer eventos dentro de um frame: vários `assistant:delta` em < 33ms viram um único redraw.

Single write + synchronized output são camadas independentes: um syscall (passo 4) garante que o kernel não fragmenta no fd; BSU/ESU garantem que o terminal não fragmenta no rasterizador. Ambos são necessários — sob key repeat (~30 chars/s), a falta de qualquer um produz flicker visível nas linhas estáticas (status, footer, réguas) que cercam o input.

### 2.3 Largura e altura

- Largura: `process.stdout.columns`. Re-detect em `SIGWINCH`.
- Altura da região viva: dinâmica, calculada por `composeLive(state) → string[]`. Mínimo 1 linha (input), máximo 15 linhas — acima disso, conteúdo extra (ex.: 50 todos) vira scrollback permanente em vez de viver na região.
- Re-layout em SIGWINCH: < 16ms (1 frame de 60fps).

### 2.4 Breakpoints

| Largura | Comportamento |
|---|---|
| ≥ 100 cols | layout completo, status line full |
| 60-99 cols | status line abreviado (`steps` → `s`, `cost` → `$`); tool cards mais compactos |
| < 60 cols | warning único: "terminal estreito (< 60 cols), UX degradada"; segue funcionando |

### 2.5 Modal overlay

Modais (permission/trust/memory write/plan approval) substituem o input dentro da região viva — não criam nova região. Status line continua. Histórico nunca é coberto.

---

## 3. Event bus (contrato)

Source-of-truth do que está acontecendo. Harness emite, renderer escuta, `--json` mode serializa.

### 3.1 Tipo

```ts
interface UIEvent {
  type: string
  ts: number       // ms desde epoch
  // payload por tipo, ver §3.2
}

interface Bus {
  emit<T extends UIEvent>(e: T): void
  on<T extends UIEvent>(type: T['type'], handler: (e: T) => void): () => void
}
```

Implementação: `EventEmitter` nativo do Node/Bun. Não usar `mitt` ou similar — uma dependência a menos.

### 3.2 Catálogo de eventos

| Evento | Quando | Renderer reage |
|---|---|---|
| `session:start` | Início da sessão (cada turn em REPL, único em one-shot) | atualiza status interno (sessionId, profile, model, planMode, projeto); reseta flags per-session (softInterrupted, exitArmed, bgProcesses). **Sem permanente em scrollback** — o user-submit inverse bar (§4.10.8) já marca início de turno; cabeçalho com session UUID seria ruído por turno em REPL e não agrega info útil ao operator (UUID interessa só pra resume/audit, lookup feito via CLI separada). |
| `session:end` | Fim da sessão | imprime marcador final em scrollback: linha em branco + verbo terminal com **duração wall-clock** quando disponível: `Cogitated for 1m23s` (done) / `Aborted (soft) after 12s` / `Failed after 8s` / `Stopped (max steps) after 1m` / `Stopped (max cost) after 1m`. Sem duração (legacy/replay): cai pra forma curta `Cogitated.` / `Aborted.` / `Failed.` etc. Formato curto, sem régua decorativa nem session UUID — o boundary é visível e a duração responde "quanto tempo isso levou?" sem o operator ter que olhar o footer ou procurar elsewhere. |
| `user:submit` | User pressiona Enter | imprime echo permanente; limpa input |
| `assistant:start` | Provider começa a streamar | abre buffer vivo de mensagem |
| `assistant:delta` | Cada chunk de texto | append no buffer; redraw |
| `assistant:end` | Mensagem completa | move buffer para scrollback (permanente) |
| `thinking:start/delta/end` | Extended thinking ativo | indicador discreto (`thinking… 12s`); never persiste |
| `tool:start` | Tool call inicia | adiciona card vivo |
| `tool:delta` | Output incremental (bash stdout, etc.) | append no card vivo |
| `tool:end` | Tool call termina | move card para scrollback |
| `permission:ask` | Permission engine pede confirmação | abre modal (substitui input) |
| `permission:answer` | User responde | fecha modal |
| `trust:ask` | Diretório/AGENTS.md desconhecido | abre modal de trust |
| `memory:write:ask` | Tool `memory_write` propõe | abre modal de memory write |
| `plan:review` | Profile orchestrated apresenta plano | abre review modal |
| `todo:update` | TodoList muda | redesenha bloco de todos vivo |
| `subagent:start/update/end` | Subagent rodando | linha viva agrupada por subagent_id |
| `bg:start/update/end` | Background process | atualiza tray na status line |
| `step:budget` | Budget warning (80%, 90%) | status line muda cor (dim → bold) |
| `checkpoint:create` | Novo checkpoint | breve flash na status line (1s) |
| `error` | Erro fatal | linha vermelha permanente; mantém sessão se possível |
| `warn` | Aviso não-fatal | linha dim permanente |
| `interrupt` | Ctrl+C / Esc Esc | mostra prompt de cancelamento |

Esquemas detalhados de payload vivem em `CONTRACTS.md` §2.6.

### 3.3 Garantias

- **Ordem causal preservada por (session_id, tool_id, subagent_id).** Eventos de uma mesma origem chegam na ordem em que foram emitidos.
- **Idempotência.** `tool:end` após `tool:end` é no-op no renderer.
- **Sem perda silenciosa.** Eventos descartados (ex.: provider crash) viram `error` ou `warn` explícitos.

---

## 4. Componentes funcionais (render → string[])

Cada elemento é uma função pura. Recebe estado, devolve linhas (com ANSI inline). Sem classes, sem reuso por herança — composição direta.

### 4.1 Tool card

> **Supersedido pela §4.10 (operation chip + sub-content).** Esta seção descreve o esboço inicial; a forma canônica do tool card é o operation chip definido em §4.10.5. Mantida aqui como referência de transição até a implementação migrar.

```ts
interface ToolCardState {
  id: string
  name: string         // 'bash', 'read', 'edit', ...
  args: string         // já formatado (uma linha, truncado)
  status: 'running' | 'done' | 'error' | 'denied'
  durationMs?: number
  outputPreview?: string[]  // até 5 linhas, truncadas
  pipeline?: { name: string; status: 'pass' | 'warn' | 'fail' }[]
}

function renderToolCard(s: ToolCardState): string[]
```

**Vivo (running):**
```
⠋ bash · npm test                                    8s
```

**Final (done):**
```
▶ bash · npm test                                    1.2s
  └ 47 passed, 0 failed                  fmt ✓ lint ✓ test ✓
```

**Final (error):**
```
✗ bash · npm test                                    2.1s
  └ exit 1: 3 tests failed (see output above)
```

Output completo de bash já saiu como conteúdo permanente via `tool:delta`. O card final é só sumário.

### 4.2 Subagent row (na região viva, agrupada)

```
⠋ code-reviewer · analyzing src/harness/loop.ts     8s
  ├ ✓ read 4 files
  ├ ✓ ran tsc
  └ … running biome
```

Quando o subagent termina (`subagent:end`), as linhas viram um único bloco permanente compacto:

```
▶ code-reviewer · 12 files reviewed · 2 issues       42s
```

Detalhes ficam acessíveis via `agent --session <id> --subagent <name>` (CLI separada, fora da TUI).

### 4.3 Todo list (vivo, opcional)

Aparece se houver TodoList ativa. Acima da status line.

```
Tasks
  ✓ Resolve scope roots from repo root
  ▶ Update bootstrap.ts callers
  ○ Add regression test
  ○ Run typecheck
```

Glyphs: `✓` done, `▶` running, `○` pending, `✗` failed (fallback ASCII: `[x]`/`[*]`/`[ ]`/`[!]`).

Mais de 8 todos: trunca pra "▶ running + próximas 2 pending + ✗ failed", com `(+12 more)` discreto.

### 4.4 Status line (sempre presente, 1 linha)

> **Removida.** A "status line acima do input" foi absorvida pelo footer §4.10.6, que já mostra `model · [plan] · steps/max · cost · [bg N]` no canto direito. Renderer não emite mais uma linha separada — duplicar info em duas posições só consome espaço vertical (e em REPL com input outdented §6.3, a linha de status no fim da live region competia visualmente com o próprio input, sem ganho informativo). Seção mantida aqui como histórico de design; conteúdo canônico está em §4.10.6.

```
[autonomous] · forja · sonnet-4.6 · 12/200 · $0.04 · mem 4u · bg 1
```

Componentes (esquerda → direita):
- `[profile]` (vazio se default)
- nome do projeto (basename do repo root)
- modelo
- steps (`12/200`, `⚠ 160/200` se ≥ 80%, `‼ 180/200` se ≥ 90%)
- cost (`$0.04`, amarelo a 80% do max, vermelho a 90%)
- memory badge (`mem 4u 2p` — 4 user, 2 project carregadas)
- background tray (`bg 1` se houver, somem se zero)
- MCP tray (`mcp 2` se conectados)

Em < 100 cols: abreviações (`steps` → omite label, mostra `12/50`; `cost` → `$0.04`; etc.).

Substituições temporárias:
- Em estado não-idle (`waiting`, `interrupting`, `compacting`): `LoopStatusLine` substitui completamente — `⠋ waiting for user response (Ctrl+C cancel)`.
- Em interrupt confirm: `interrupt? press Esc again to cancel · Enter to continue`.

### 4.5 Input box (sempre presente, 1-3 linhas)

```
> _
```

Multi-linha: shift+Enter ou auto-grow ao colar texto com `\n`. Limite de display: 3 linhas; conteúdo maior abre modo "expanded" (ver §5.1).

Affordance ao iniciar:
```
> Ask anything. /help for commands. Ctrl+C to cancel, Esc Esc to interrupt.
```
(dim, some no primeiro keystroke).

### 4.6 Permission modal

> **Supersedido por §4.10.13 (permission modal canônico).** Esta seção descreve o esboço inicial (2 ações em linha horizontal); a forma canônica usa título estruturado, preview tool-aware (diff/comando), lista numerada de 3 opções e hint footer interno. Mantida aqui como referência de transição.

Substitui o input box. Status line permanece.

```
─────────────────────────────────────────
  bash · rm -rf ./build
  cwd: /home/lex/forja

  [a] accept   [r] reject   [e] edit   [w] why?
─────────────────────────────────────────
```

Com risk explanation (`w`):
```
─────────────────────────────────────────
  bash · rm -rf ./build
  cwd: /home/lex/forja

  ⚠ destructive write outside known build artifacts
    matched policy rule: bash.rm.rf

  [a] accept   [r] reject   [e] edit
─────────────────────────────────────────
```

### 4.7 Trust prompt

```
─────────────────────────────────────────
  ⚠ unknown directory

  /home/lex/some-repo
  AGENTS.md present (not yet trusted)

  [t] trust this dir   [s] trust + remember
  [n] no, read-only this session
─────────────────────────────────────────
```

### 4.8 Memory write prompt

```
─────────────────────────────────────────
  memory write proposed

  scope: project
  name: build-command
  body: "Use 'bun run build' (not npm). Bun is the only supported runtime."

  [a] accept   [e] edit   [s] skip
─────────────────────────────────────────
```

### 4.9 Plan review (profile orchestrated)

```
─────────────────────────────────────────
  plan review · 3 steps

  1. read src/harness/loop.ts
  2. edit src/harness/loop.ts (add interrupt handler)
  3. run bun test tests/harness/loop.test.ts

  estimated: 4 tool calls · ~$0.02

  [a] approve   [e] edit   [r] reject
─────────────────────────────────────────
```

### 4.10 Layout-alvo (engenharia)

> **Esta seção é a referência canônica do layout.** §4.1 (tool card) e §4.4 (status line position) foram supersedidas; demais componentes (modal, todo list, subagent row) compõem com este alvo sem conflito.

#### 4.10.1 Insight central

O layout não é "bonito" — é **observabilidade vestida de chat**. Cada elemento responde uma pergunta operacional concreta sem parecer dashboard:

| Pergunta | Resposta na UI |
|---|---|
| Travou? | Counter live no operation chip (`12s · ↑ 234 tokens`) |
| Quanto tempo passou? | Chip final no scrollback (`Generated in 8.2s`) vira landmark |
| Em que tool? | Verbo + sub-content (`Reading file… └─ src/foo.ts`) |
| Que config está em vigor? | Footer direito (`• sonnet-4.6 · 3/50 · $0.012`) |
| O que posso fazer agora? | Footer esquerdo, contextual (`esc to interrupt` só quando interruptable) |
| Onde foi que perguntei X? | User echo em barra invertida full-width — divisor visual no scrollback |

Forja já tem todos os dados (sessão, custo, plan, tools, durations); a tarefa do layout-alvo é **apresentá-los na forma que o engenheiro absorve passivamente**.

#### 4.10.2 Hierarquia visual

- **Dim baseline.** ~80% do texto renderizado é dim grayscale. Bold/cor entram só onde precisam: títulos, chip ativo (cor quente), erro (cor de erro). Sem o baseline dim, nada se destaca.
- **Cor reservada.** `success`, `warn`, `error` da paleta (§6.1) marcam estado terminal de operação. Nunca decoração. Chip ativo usa `warn` (cor quente) durante execução; chip final volta para dim.
- **Âncora inferior estável.** Quatro elementos sempre na mesma posição, na mesma ordem: régua → input (cursor inline) → régua → footer. Live region cresce **acima**, nunca disturba o anchor.
- **Scrollback como navegação.** User echo em barra invertida cumpre papel de heading sem inventar headings. Rolando, as barras orientam ("onde foi que perguntei X?").

#### 4.10.3 Vocabulário técnico — operações

Verbo no presente contínuo enquanto ativo. Particípio passado quando completo.

| Operação | Ativo | Finalizado |
|---|---|---|
| Provider call (texto streaming) | `Generating… (8s · ↑ 234 tokens)` | (suprimido — assistant turn não imprime chip final, só a prosa direto; duração vai no marcador de fim de turno §3.2 `Cogitated for X`, contagem de tokens vai no footer §4.10.6) |
| Extended thinking | `Thinking… (3s)` | `Thought for 3.1s` |
| Tool execution | per-tool verb (§4.10.4) | per-tool verb (§4.10.4) |
| Compaction | `Compacting context… (12s)` | `Compacted 12 messages in 850ms` |
| Checkpoint | `Checkpointing… (50ms)` | `Checkpointed at step 3 (a1b2c3d)` |
| Subagent run | `Delegating to <name>… (Xs)` | `Delegated to <name> (Ys · N steps)` |
| Permission ask | `Awaiting approval…` | `Approved` / `Denied` |
| Step boundary | (não é chip — é separador, §4.10.8) | `── step 3/50 ── $0.012 ──` |

Princípio: **verbo é a ação real**, não rótulo genérico.

#### 4.10.4 Vocabulário técnico — per-tool

| Tool | Ativo | Finalizado | Sub-content |
|---|---|---|---|
| `read_file` | `Reading file…` | `Read 1 file (2.4kB)` | `└─ src/foo.ts` |
| `write_file` | `Writing file…` | `Wrote src/foo.ts (+42 lines)` | `└─ src/foo.ts` |
| `edit_file` | `Editing file…` | `Edited src/foo.ts (+3 −1)` | `└─ src/foo.ts:42` |
| `bash` | `Executing…` | `Exited 0 in 1.2s` | `└─ rg "pattern" src/` |
| `bash_background` | `Spawning…` | `Spawned pid 12345` | `└─ npm run dev` |
| `bash_output` | `Polling pid 12345…` | `Read 234 bytes` | `└─ pid 12345` |
| `bash_kill` | `Killing pid 12345…` | `Killed pid 12345 (SIGTERM)` | `└─ pid 12345` |
| `glob` | `Globbing…` | `Matched 14 files` | `└─ src/**/*.ts` |
| `grep` | `Grepping…` | `Matched 3 in 14 files` | `└─ "createBus" src/tui` |
| `task` (subagent) | `Delegating to <name>…` | `Delegated to <name> (Xs · N steps)` | `└─ goal: review repl.ts` |
| `memory_list` | `Listing memory…` | `Listed 7 entries` | `└─ scope: project_local` |
| `memory_read` | `Reading memory…` | `Read user/<name>.md` | `└─ user/user_role.md` |
| `memory_search` | `Searching memory…` | `Matched 2 entries` | `└─ "deployment"` |
| `todo_*` | `Updating todos…` | `Updated 3 items` | `└─ +1 done, −1 pending` |

Princípio: **subject = o argumento que diz o quê**. Path, command, query, pid. Nunca o JSON inteiro. JSON cru fica atrás de `(ctrl+o to expand)` (§4.10.5).

Adicionar tool nova exige escolher (verb-active, verb-final, subject-extractor) — registrado em `src/tui/tool-vocab.ts` (criação documentada em backlog quando o slice landar). Sem entrada → fallback para `Calling <tool>… / Called <tool>` + JSON args truncado a 80 chars (intencionalmente feio para sinalizar "falta vocabulário").

#### 4.10.5 Operation chip (lifecycle)

```ts
interface OperationChip {
  id: string                      // toolUseId, messageId, etc.
  state: 'active' | 'final'
  verb: string                    // 'Reading file', 'Generating', ...
  durationMs: number              // live enquanto active, fixo quando final
  tokens?: number                 // ↑ output tokens (provider call)
  subject?: string                // sub-content em uma linha
  expandable?: boolean            // mostra '(ctrl+o to expand)' se true
  status?: 'done' | 'error' | 'denied'  // só em state=final
}
```

**Ativo (live, na live region):**
```
* Reading file… (1.2s)
└─ src/foo.ts
```

**Ativo (com tokens, ex: provider call):**
```
* Generating… (8s · ↑ 234 tokens)
```

**Final (scrollback, dim):**
```
* Read 1 file (2.4kB)
└─ src/foo.ts
```

**Final (error, cor de erro no glyph apenas):**
```
* Exited 1 in 2.1s
└─ rg --invalid-flag
```

**Final (denied, cor warn no glyph):**
```
* Denied
└─ bash command 'rm -rf /' matches deny rule
```

**Glyph** `*` em todos os estados (Unicode prefere `▸` ativo, `·` final; ASCII fallback `*`). Cor: ativo = `warn`; final done = dim; final error = `error`; final denied = `warn`.

Counter format: `(Xs · ↑ N tokens)` quando há geração; `(Xs)` quando não há (thinking, tool sem stream). Símbolo `↑` literal pra "saída acumulada" — engenheiro reconhece como uplink/output direction.

Expansion (`ctrl+o`) abre um painel scrollable com o JSON args completo + output bruto. Painel é **modal** (§4.6 shape, conteúdo livre); fecha com Esc. Não implementado em M1; o hint `(ctrl+o to expand)` aparece mas tecla não responde até o slice de expansion landar.

#### 4.10.6 Footer (status surface dinâmico)

Sempre 1 linha, dim, **abaixo do input box** (com régua entre eles).

| Estado | Esquerda | Direita |
|---|---|---|
| Idle | `? for help · \+Enter newline` | `• <model> · <steps>/<max> · $<cost>` |
| Idle, exit armed (§5.4) | `Press Ctrl-C again to exit` (`warn`) | (mesmo) |
| Running | `? for help · \+Enter newline · esc to interrupt` | `• <model> · <steps>/<max> · $<cost>` |
| Soft-aborted (ainda processando) | `? for help · \+Enter newline · esc again to force` | (mesmo) |
| Plan mode | `? for help · \+Enter newline` | `• <model> · plan · <steps>/<max> · $<cost>` |
| Modal up | (suprimido — modal cobre footer) | (suprimido) |

Esquerda = **"o que posso fazer agora?"**. Hint de help + interrupt **só quando interruptable**.

Direita = **"o que está em vigor?"**. Model · [plan ·] steps/max · cost. Slash commands implícitos: `/model`, `/plan`, `/budget` mudam cada um. Memory badge / bg / mcp (§4.4 conteúdo original) entram conforme presentes; em < 100 cols, somem por ordem de prioridade: mcp → bg → mem → cost label.

Princípio: footer é **status surface, não help surface**. Nada de listar atalhos ou opções de menu. Help fica atrás de `?`.

#### 4.10.7 Sub-content connector

Subordinação visual com `└─ ` (ASCII fallback `\- `). Sempre **uma linha**. Se não cabe, vira tool output e vai pra expansion (§4.10.5).

Casos:
- Path: `└─ src/foo.ts:42`
- Command: `└─ rg "pattern" src/`
- Query: `└─ "createBus" src/tui`
- Pid: `└─ pid 12345`
- Subagent goal: `└─ goal: review repl.ts`
- Razão (denied/error): `└─ denied: bash command 'rm -rf /' matches deny rule`

Multi-tool ops (ex: `glob` matched 14 files) cita o **padrão**, não a lista — lista vai pra expansion. Sub-content é dim em todos os estados.

#### 4.10.8 User echo (inverse bar)

```
> a tui já funciona?
```

Renderizado com SGR `7` (reverse) preenchendo da col 2 até `cols-1` — branco em fundo escuro como divisor estrutural no scrollback. Os 2sp à esquerda são a frame margin (§6.3); a barra fica visualmente alinhada ao resto do conteúdo recuado. Rolando, as barras servem de heading natural para localizar turnos.

Régua dim acima e abaixo do echo é **opcional** (decisão final na implementação após smoke test visual). Default: sem régua adicional, deixa a inversa carregar o destaque sozinha.

ASCII fallback: SGR `7` é universal em qualquer terminal — sem fallback necessário. Em cor desabilitada (`NO_COLOR`), reverse continua funcionando (não é cor, é atributo).

#### 4.10.9 Welcome banner (scrollback)

Emitido **uma vez** no boot do REPL, como `PermanentItem` kind `'session-banner'`. Estruturado em **3 blocos** separados por linha em branco — banner em densidade alta colava no input e violava o princípio "hierarquia vem de spacing/peso, não de cor" (§6.4). Spacing carrega a estrutura; paleta segue mínima.

```
forja v0.0.0

anthropic/claude-sonnet-4-6 · 200k ctx · max 4096 out
/run/media/lex/.../forja

policy: project (5 rules) · subagents: 2 · ✓ checkpoints · ✓ memory (14)
```

| Bloco | Linhas | Estilo | Pergunta |
|---|---|---|---|
| 1 (title) | 1 | `bold` | Qual versão? |
| 2 (identity) | 2 | `dim` | Qual modelo (limites concretos: context window, max output) e em qual cwd? |
| 3 (env) | 0 ou 1 | misto | O que está ligado nesta sessão? |

**Versão prefixada com `v`** (`forja v0.0.0`, não `forja 0.0.0`) — convenção semver, identifica a string como versão à primeira leitura.

**Bloco 3 (env)** mistura dois estilos numa única linha, separados por ` · `:

- **Indicadores de capability binária habilitada** (`checkpoints`, `memory`) usam o glyph `✓` (§6.2) pintado com token `success` (§6.1); o nome do indicador fica em `default`. Contagem opcional entre parênteses (`✓ memory (14)`). Itens em estado desligado **não são impressos** — a linha lista o que existe, não o que não existe.
- **Metadata key:value não-binária** (`policy: project (N rules)`, `subagents: N`) fica em `dim`. Sem glyph.

Quando nenhum indicador binário estaria true e nenhuma metadata útil existe (sem subagents, sem checkpoints, sem memory, sem policy customizada), o **bloco 3 é omitido inteiro** — banner termina após o bloco 2, sem linha em branco terminal vazia. Producer (`session:banner`) sinaliza isso enviando `env: []`.

Vai pro scrollback — uma vez impresso, scrolla naturalmente conforme a conversa cresce. **Sem header fixo.** Sem logo. Sem mascot. (Se um dia identidade visual virar pauta, ASCII art opcional via flag — não default.)

Em modo `--json`, o banner é emitido como `{type: 'session:banner', ...}` no NDJSON em vez de linhas formatadas.

#### 4.10.10 Step separator

```
── step 3/50 ── $0.012 ──
```

Régua dim com state inline. Aparece quando um turno fecha e outro vai abrir (substitui o `session-footer` em modo REPL). Largura preenche a coluna do terminal com `─`.

Em modo one-shot, o separator não aparece — o `session-footer` continua sendo o único marcador final (compatibilidade preservada).

#### 4.10.11 Anti-vocabulário

Banidos do vocabulário operacional:

- `Working`, `Loading`, `Processing`, `Please wait` — vagos.
- `Handling`, `Managing`, `Orchestrating` — abstratos.
- `Just a moment…`, `Working on it…` — cortesia, desperdício de coluna.
- `Ready!`, `Done!`, `Success!` (com **exclamação**) — banidos como **status messages durante operação**. O **marcador de fim de turno** em scrollback (§3.2 `session:end`) usa verbo no particípio passado + duração wall-clock: `Cogitated for 1m23s` (done) / `Aborted after 12s` / `Failed after 8s` / `Stopped (max steps) after 1m`. Verbo concreto + número responde "quanto tempo o turno levou?" sem entusiasmo nem duplicação com o footer. Sem duração disponível (legacy/replay): forma curta `Cogitated.` / `Aborted.` / `Failed.`
- Emoji decorativo (✓ ✗ ⚠️ 🔧 💭 🚀) — depende de fonte/terminal, conflita com paleta dim. Glyphs canônicos da §6.2 são exceção (são informativos, não decorativos).
- Metáforas culinárias/artesanais ("Baking", "Cooking", "Brewing", "Forging") — engenheiro lê verbo literal melhor que metáfora.
- Mascote, ícones de marca, logo — fora de escopo do core; flag opcional se virar pauta.

#### 4.10.12 Layout completo (referência ASCII)

```
┌─ scrollback (permanent items, 2sp left margin §6.3) ────────────────┐
│   forja v0.0.0                                  ← title (bold)      │
│                                                                     │
│   anthropic/claude-sonnet-4-6 · 200k ctx · max 4096 out ← identity  │
│   /run/media/lex/.../forja                                          │
│                                                                     │
│   policy: project (5 rules) · subagents: 2 · ✓ checkpoints          │
│                                                                     │
│                                                 ← blank (turn boundary) │
│   > a tui já funciona?                          ← inverse bar (§4.10.8) │
│                                                 ← blank             │
│   * Reading file (2.4kB)                        ← chip final, dim   │
│   └─ src/foo.ts                                                     │
│                                                 ← blank             │
│   Sim, em teoria funciona...                    ← assistant text    │
│                                                 ← blank             │
│   Cogitated for 8.2s                            ← turn-end (§3.2)   │
└─────────────────────────────────────────────────────────────────────┘
─────────────────────────────────────────────────────────────────────  ← régua (full width, col 0)
> ▌                                                                   ← input + cursor (col 0)
─────────────────────────────────────────────────────────────────────  ← régua (full width, col 0)
  ? for help · \+Enter newline · esc to interrupt   • sonnet-4.6 · 3/50 · $0.012  ← footer (padded)
```

Live region (entre as réguas e a inferior):
- Operation chips ativos (com counter live).
- Todo list (§4.3) acima dos chips, se houver.
- Modal (§4.6+) substitui o input box quando aberto; footer suprimido.

#### 4.10.13 Permission modal canônico

Substitui §4.6. Layout estruturado em 4 blocos (título, preview tool-aware, pergunta+opções, hint footer interno) com lista numerada vertical e cursor `>`.

**Visual de referência (`edit_file` em `.gitignore`):**

```
─────────────────────────────────────────────────────────────────
  Edit file
  .gitignore
─────────────────────────────────────────────────────────────────
  25
  26  # Bun
  27  .bun/
  28  +
  29  +foobar
─────────────────────────────────────────────────────────────────
  Do you want to make this edit to .gitignore?
    1. Yes
    2. Yes, allow all edit_file during this session (shift+tab)
  > 3. No
  Esc to cancel
```

`>` marca a opção selecionada (default = `3. No`). Apertar `1`/`2`/`3` ativa direto sem navegar.

**Visual `bash` destrutivo:**

```
─────────────────────────────────────────────────────────────────
  Run command
  rm -rf ./build
─────────────────────────────────────────────────────────────────
  $ rm -rf ./build
  cwd: /run/media/lex/.../forja
  matched policy rule: bash.rm.rf (deny by default)
─────────────────────────────────────────────────────────────────
  Do you want to run this command?
    1. Yes
    2. Yes, allow all bash during this session (shift+tab)
  > 3. No
  Esc to cancel
```

**Bloco 1 — Título.** Verbo bold + subject dim. Verbos canônicos por tool:
- `read_file` → não pede permissão (read-only sempre passa).
- `write_file` → `Write file` / `<path>`.
- `edit_file` → `Edit file` / `<path>`.
- `bash` → `Run command` / `<command, truncado>`.
- `bash_background` → `Spawn process` / `<command, truncado>`.
- `bash_kill` → `Kill process` / `pid <N>`.
- `task` (subagent) → `Spawn subagent` / `<name>`.
- `memory_write` → `Write memory` / `<scope>/<name>`.
- Sem entrada → `Use <toolName>` / args truncados a 80 chars.

**Bloco 2 — Preview tool-aware.** Cada tool registra `previewForApproval(args, ctx): string[]` no `ToolDef` (ver `CONTRACTS.md §2.6` — extensão a ser propagada). Conteúdo:

| Tool | Preview |
|---|---|
| `edit_file` | Diff com line numbers, contexto ±3 linhas em torno das mudanças, `+`/`-` prefix |
| `write_file` | Primeiras N linhas do conteúdo (cap em 20), com `(file is N lines, showing first 20)` se maior |
| `bash` / `bash_background` | `$ <command>` + `cwd: <path>` + (opcional) `matched policy rule: <id>` se vier de `confirm` decision |
| `bash_kill` | `pid <N>` + `command: <cmdline>` + `started: <relative time>` |
| `task` | `goal: <text>` + `whitelist: <tools>` + `budget: <maxSteps>` |
| `memory_write` | `scope: <s>` + `name: <n>` + corpo bruto (cap em 10 linhas) |

Sem `previewForApproval` registrado → fallback para `args: <JSON.stringify(args, null, 2)>` truncado a 20 linhas (intencionalmente cru pra sinalizar "tool não declarou preview adequado"). Tools que invocam recursos externos (`bash`, `task`) **devem** registrar — falha de preview = falha de spec.

**Bloco 3 — Pergunta + opções.** Pergunta em linguagem natural derivada do verbo (`Do you want to <verb-imperative> <subject>?`). Opções (3 fixas para permission, conforme D64):

```
  1. Yes
  2. Yes, allow all <toolName> during this session (shift+tab)
> 3. No
```

Atalhos:
- `1`/`2`/`3` → ativam direto.
- `↑`/`↓` ou `Tab`/`Shift+Tab` → navegam.
- `Enter` → confirma a selecionada.
- `Shift+Tab` → atalho secundário pra opção 2 (session-allow), exposto no label entre parênteses.
- `Esc` → cancela (semântica distinta de `No`; ver D5 / regra 9 da §5.5).

**Bloco 4 — Hint footer interno.** Linha dim com `Esc to cancel`. Em M1 só esse hint. Quando `Tab to amend` (v2) landar, vira `Esc to cancel · Tab to amend`. Hints são parte do `ConfirmState.hints` (§5.5) — caller controla.

**Semântica das opções (`value` no `permission:answer`):**

| Opção | `value` | Efeito |
|---|---|---|
| 1. Yes | `'yes'` | Aprova esta invocação. Sem efeito persistente. |
| 2. Yes, allow all | `'session-allow'` | Aprova esta invocação **e** grava regra na session-layer da policy (`tools.<toolName>: allow`). Próximas invocações do mesmo tool nesta sessão não geram modal. Sessão fecha → regra evapora. |
| 3. No | `'no'` | Rejeita explicitamente. Caller (harness) trata como `denied` no `tool_finished` (§HarnessEvent). |
| Esc | `'cancel'` | Desistência. Audit-distinct de `'no'`; caller pode tratar diferente (ex: replay-friendly logs marcam cancel vs reject). Para o tool, idêntico a `'no'`. |

**Decisões registradas:**

- **D63 — Preview tool-aware obrigatório para tools com side-effect.** `edit_file`/`write_file`/`bash`/`bash_background`/`bash_kill`/`task`/`memory_write` precisam de `previewForApproval` registrado. Read-only tools nem chegam ao modal. Fallback de `JSON.stringify` é deliberadamente feio pra forçar o registro adequado em code review.
- **D64 — Session-bypass scoped por tool name.** Opção 2 escreve `tools.<toolName>: { default: 'allow' }` na session-layer. Não é "approve everything" — é "approve all calls do mesmo tool". Engine respeita a hierarquia normal (enterprise/user/project ainda podem deny por glob/categoria). Sessão-wide escopo: morre quando a sessão fecha; não persiste para resume.
- **D65 — Default-NO via `selectedIndex = options.length - 1`.** Generaliza D5 do esquema yes/no para listas de N opções. Convenção: a última opção é sempre a mais conservadora. Caller que precisar de outro default deve documentar a justificativa no BACKLOG (e a code review checa). Permission, trust, memory-write seguem; plan-review tem 3 opções (approve/edit/reject) onde reject = última.

**O que ainda não está aqui (deferred):**

- **`Tab to amend`** — feature v2. Edit-then-confirm exige input editor aninhado dentro do modal (focus stack 3-deep, persistência da edição, validação por tool). M1 não mostra a hint; quando landar, o producer adiciona `'Tab to amend'` em `hints` e o focus handler intercepta `Tab` antes da navegação.
- **`Why?` explanation** — antiga `[w]` da §4.6. Preview tool-aware já carrega `matched policy rule: ...` quando o tool veio de uma `confirm` decision do engine; explicação adicional fica como expansion futura via `(ctrl+i for risk details)` ou similar.
- **Outros flavors visuais** (trust, memory-write, plan-review, critique). Compartilham o `ConfirmState` shape de §5.5; layout específico de cada um lands no slice que conectar o producer correspondente.

---

## 5. Padrões de interação

### 5.1 Input handling

- `process.stdin.setRawMode(true)` no boot (TTY only). Restore em qualquer exit path (incl. Ctrl+C, exceptions).
- Parser de escape sequences manual: setas, Home/End, Delete, Ctrl+A/E/U/W/K, Alt+B/F (word jumps), Ctrl+Backspace, Enter, Shift+Enter.
- **Bracketed paste** (`\x1b[200~...\x1b[201~`): habilitado no boot, processado em batch (sem disparar redraw por char).
- Histórico de input: ver `HISTORY.md` (subsistema próprio — SQLite-backed, per-project, com privacy opt-out, slash command `/history`, navegação ↑/↓ e reverse-search `Ctrl+R`).
- Expanded input mode: paste com >3 linhas abre buffer de N linhas no lugar do input, com `[Esc] cancel · [Ctrl+D] submit · [Ctrl+E] open $EDITOR`.

### 5.2 Spinner

```ts
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
let i = 0
setInterval(() => { i = (i+1) % FRAMES.length; bus.emit({ type:'tick', ts:Date.now() }) }, 80)
```

ASCII fallback: `['|','/','-','\\']` em 100ms.

Renderer reage a `tick` igual a qualquer evento (redraw da região viva).

### 5.3 Slash commands

- `/` no início do input ativa autocomplete inline (lista a < 8 itens em popover acima do input, dentro da região viva).
- Tab completa o item destacado. Setas navegam. Esc fecha.
- Comandos descobertos via registry (mesmo registry do `--help`).

### 5.4 Keybindings (cheat sheet)

| Tecla | Estado | Ação |
|---|---|---|
| Enter | input | submit |
| Shift+Enter | input | nova linha |
| `\` + Enter | input | nova linha — backslash continuation (convenção shell). Útil em terminais/WMs que comem Shift+Enter. Char antes do cursor era `\` → renderer troca pelo `\n` (cursor fica no mesmo índice, agora à direita do `\n`). |
| Ctrl+C | input não vazio | limpa o buffer (não sai) |
| Ctrl+C | idle, buffer vazio | **arma exit** — footer mostra `Press Ctrl-C again to exit` (cue em `warn`); janela de 2s |
| Ctrl+C (2x dentro de 2s) | idle, buffer vazio | exit 130 (POSIX SIGINT) |
| Ctrl+C | running | cancela step atual (graceful) |
| Ctrl+C (2x) | running | hard kill |
| Esc | running | request soft interrupt (LLM termina passo, depois para) |
| Esc Esc | running | hard interrupt (cancela tool em curso) |
| Ctrl+L | qualquer | clear screen (mantém histórico no scrollback) |
| Ctrl+R | input | reverse search no histórico (ver `HISTORY.md` §2.2) |
| Ctrl+D | input vazio | exit imediato (EOF — convenção shell, sem gate) |
| Tab | input com `/` | autocomplete |
| Ctrl+Z | qualquer | suspend (SIGTSTP), retorna com `fg` |
| ↑/↓ | input | navegar histórico de inputs (ver `HISTORY.md` §2.1) |

**Idle Ctrl+C double-tap:** o gate só aplica em `idle + buffer empty + sem run em curso`. Outros estados têm seus próprios paths (running tem o ladder soft/hard separado §3; buffer não vazio limpa). Janela de 2s é desarmada por: timeout, qualquer tecla (incluindo digitação), submit, abertura de modal, ou início de turno. Ctrl+D **não** passa pelo gate — EOF é convenção de shell para "I'm done", uma única tecla equivale a uma decisão explícita; aplicar double-tap aqui surpreende.

### 5.5 Modal pattern (canônico)

Modal **não é popup**. É:

> estado + handler no topo da focus stack + promise.

Sem framework. Sem reconciler. Sem componentes reutilizáveis.

#### Estado (generalizado para N opções)

```ts
interface ConfirmOption {
  // Hotkey de ativação. Convencionalmente '1','2','3' para opções
  // numeradas; pode ser letra ('a','r','e') para mnemônicos.
  key: string
  label: string                // 'Yes', 'Yes, allow all edits during this session', 'No'
  // Semântica processada pelo caller — `value` viaja no
  // permission:answer (ou flavor equivalente). Permission-flavor
  // usa 'yes' | 'session-allow' | 'no'; outros flavors definem
  // seu próprio union.
  value: string
  // Atalho secundário opcional (ex: 'shift+tab' para a opção
  // session-allow no permission modal). Mostrado entre parênteses
  // após o label; não bloqueia a hotkey numérica.
  shortcut?: string
}

interface ConfirmState {
  promptId: string
  flavor: 'permission' | 'trust' | 'memory-write' | 'plan-review' | 'critique'
  // Bloco de título: verbo bold + subject dim na linha de baixo.
  // Para permission: ('Edit file', '.gitignore'); para trust:
  // ('Trust directory', '/path/to/repo'). Subject é opcional —
  // ausente quando o modal não tem alvo único.
  title: string
  subject?: string
  // Conteúdo tool-aware: diff (edit), comando (bash), corpo (memory),
  // lista de steps (plan), etc. Lines já formatadas (cores, line
  // numbers). O modal renderiza-as entre réguas; sem preview, omite
  // o bloco inteiro (sem régua extra).
  preview: string[]
  // Pergunta em linguagem natural. Se ausente, o modal pula a linha
  // antes da lista — útil quando o título já fechou a pergunta.
  question?: string
  options: ConfirmOption[]
  // Default = última opção (convenção: última = NO/cancel/skip).
  // Caller que precisar de outro default seta explicitamente —
  // mas D5/D65 mandam usar `options.length - 1` salvo justificativa.
  selectedIndex: number
  // Hints renderizados no rodapé do modal (separados por ' · ').
  // Sempre inclui 'Esc to cancel'; producers adicionam 'Tab to amend'
  // (v2), 'shift+tab to bypass' etc. Ordem importa: esquerda → direita.
  hints: string[]
  timeoutMs?: number
}
```

#### Render (substitui o input dentro da região viva)

```ts
function renderConfirm(c: ConfirmState, caps: Capabilities): string[] {
  const rule = caps.unicode ? '─'.repeat(caps.cols) : '-'.repeat(caps.cols)
  const cursor = caps.unicode ? '>' : '>'  // mesmo glyph; placeholder
  return [
    rule,
    paint(caps, 'bold', `  ${c.title}`),
    ...(c.subject ? [paint(caps, 'dim', `  ${c.subject}`)] : []),
    rule,
    ...c.preview.map(l => `  ${l}`),
    rule,
    ...(c.question ? [`  ${c.question}`] : []),
    ...c.options.map((opt, i) => {
      const marker = i === c.selectedIndex ? cursor : ' '
      const shortcut = opt.shortcut ? paint(caps, 'dim', ` (${opt.shortcut})`) : ''
      return `${marker} ${opt.key}. ${opt.label}${shortcut}`
    }),
    paint(caps, 'dim', `  ${c.hints.join(' · ')}`),
  ]
}
```

Modais substituem **o input box e o footer global** (footer global é suprimido enquanto modal ativo — modal traz seu próprio footer interno via `c.hints`). Histórico (scrollback) permanece visível acima. `composeLive(state)` chama `renderConfirm()` em vez de `renderInput()` quando `state.modal !== null`. Não há "overlay" sobre o histórico — região viva é dona dela mesma.

#### Focus handler (push no topo da stack)

```ts
pushFocus(key => {
  if (!state.modal) return false
  const m = state.modal
  // Hotkey numérica/letra ativa diretamente.
  const hit = m.options.findIndex(o => keyMatches(key, o.key))
  if (hit >= 0) {
    resolveModal(m.options[hit].value)
    return true
  }
  // Atalho secundário (ex: shift+tab → session-allow).
  const sc = m.options.findIndex(o => o.shortcut && keyMatches(key, o.shortcut))
  if (sc >= 0) {
    resolveModal(m.options[sc].value)
    return true
  }
  if (key === 'up' || key === 'shift+tab') {
    m.selectedIndex = Math.max(0, m.selectedIndex - 1)
    bus.emit({type: 'modal:select', promptId: m.promptId, selectedIndex: m.selectedIndex})
    return true
  }
  if (key === 'down' || key === 'tab') {
    m.selectedIndex = Math.min(m.options.length - 1, m.selectedIndex + 1)
    bus.emit({type: 'modal:select', promptId: m.promptId, selectedIndex: m.selectedIndex})
    return true
  }
  if (key === 'enter') {
    resolveModal(m.options[m.selectedIndex].value)
    return true
  }
  if (key === 'escape') {
    resolveModal('cancel')  // distinto de 'no' — cancel é desistência
    return true
  }
  return true  // bloqueia o resto enquanto modal ativo
})
```

#### API async (permission flavor)

```ts
function askPermission(args: PermissionAskArgs, opts?: ConfirmAskOptions): Promise<PermissionAnswer> {
  return enqueueConfirm({
    flavor: 'permission',
    title: titleFor(args.toolName),         // 'Edit file', 'Run command', ...
    subject: subjectFor(args),              // '.gitignore', 'rm -rf ./build', ...
    preview: args.preview ?? [],            // tool registra via previewForApproval
    question: questionFor(args.toolName, args),
    options: [
      { key: '1', label: 'Yes',                                         value: 'yes' },
      { key: '2', label: `Yes, allow all ${args.toolName} during this session`,
        value: 'session-allow', shortcut: 'shift+tab' },
      { key: '3', label: 'No',                                          value: 'no' },
    ],
    selectedIndex: 2,                       // D5/D65 — default = NO (última opção)
    hints: ['Esc to cancel'],               // 'Tab to amend' adicionado quando v2 landar
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
}
```

Outros flavors (trust, memory-write, plan-review, critique) constroem suas próprias listas de opções — geralmente 2 (yes/no) ou 3 (approve/edit/reject). `selectedIndex` default fica na última (rejeição/cancelamento) por convenção D65, com exceção justificada documentada na BACKLOG.

#### Regras (não-negociáveis)

1. **Default = última opção** (`selectedIndex = options.length - 1`). Convenção: a última opção é a mais conservadora (No / Reject / Skip / Cancel). Enter sem navegar = escolha conservadora. Salva muita unha. (Ver D5 e D65.)
2. **Cursor `>` à esquerda da opção selecionada** (ASCII universal). Sem cor sólida no item — manter dim baseline. Cor só na borda de status final (`success` após accept, `error` após reject), opcional.
3. **Bloqueio total do input normal** enquanto modal ativo. O `return true` no fim do handler garante que tecla nenhuma vaza pra baixo na focus stack. Footer global da app (§4.10.6) é suprimido — o modal traz seu próprio rodapé via `hints`.
4. **Largura full-cols** com `padEnd` em todas as linhas internas. Sem isso, ANSI errado quebra o redraw.
5. **Sem reflow durante input.** Resize (SIGWINCH) durante modal: reposiciona, não reflua texto.
6. **Timeout opcional, default rejeita.** `permission:ask` sem timeout (espera o user). `trust:ask` com 5min (rejeita pra read-only). Plan review sem timeout.
7. **Re-render mínimo.** Mudança de `selectedIndex` redesenha só a região viva, nunca o histórico.
8. **Hotkey numérica direta.** Apertar `1`/`2`/`3` ativa a opção correspondente sem navegar primeiro. Atalhos secundários (`shortcut`) idem.
9. **Esc é cancel, não NO.** O handler resolve com `'cancel'` (distinto de `'no'`) quando Esc é pressionado. Audit/telemetria diferencia "usuário rejeitou explicitamente" de "usuário desistiu sem decidir". Caller que não diferencia trata ambos como rejeição.

### 5.6 Modal queue

Múltiplos prompts simultâneos: enfileiram. Renderer mostra um por vez, FIFO. Status line indica `(2 more)` quando há fila. Cada modal traz seu próprio `timeoutMs` (regra 6 acima).

### 5.7 Focus stack

```ts
type FocusHandler = (key: Key) => boolean  // retorna true se consumiu

const stack: FocusHandler[] = [inputHandler]
function pushFocus(h: FocusHandler) { stack.push(h) }
function popFocus() { stack.pop() }
function dispatch(k: Key) { for (let i=stack.length-1; i>=0; i--) if (stack[i](k)) return }
```

~30 linhas resolvem. Ordem (top → bottom): modal ativo, input.

---

## 6. Cor, glyphs, tipografia

### 6.1 Paleta (mínima)

| Token | Uso | ANSI |
|---|---|---|
| `default` | texto normal | (sem escape) |
| `dim` | meta, hints, separadores (réguas, footer, sub-content `└─`) | `\x1b[2m` (faint) |
| `secondary` | marker visivelmente grey que precisa se separar do conteúdo primário (turn-end `Cogitated for X`, §3.2) | `\x1b[90m` (bright-black ≈ grey) |
| `bold` | ênfase, header de modal | `\x1b[1m` |
| `error` | mensagens de erro, status falho | `\x1b[31m` |
| `warn` | avisos, budget 80% | `\x1b[33m` |
| `success` | pipeline badges (`✓`) e indicadores binários de capability habilitada no banner env (§4.10.9) | `\x1b[32m` |

**Sem mais cores.** Sem azul, sem ciano, sem magenta, sem gradientes, sem 256-color, sem truecolor. Profile/model/etc. ficam em `default`. Se você precisa de cor pra distinguir, o layout falhou.

**Nota sobre `dim` vs `secondary`:** `dim` (SGR 2 faint) é o token tradicional para meta — réguas, hints, sub-content. Em xterm com config padrão, SGR 2 renderiza idêntico ao default; aceito porque no contexto desses elementos a posição já carrega a hierarquia. **`secondary`** (SGR 90 bright-black) é o variante explicitamente visível, reservado pra marker que PRECISA destacar do conteúdo primário (turn-end `Cogitated for X` da §3.2). SGR 90 é uma cor 16-color (cinza), não "mais uma cor" no sentido das proibidas (azul/ciano/magenta).

`NO_COLOR` env var ou `--no-color`: desativa todos os escapes. `CLICOLOR_FORCE=1` ignora `!isTTY` e força cores (útil em log capture).

### 6.2 Glyphs

| Semântica | Unicode | ASCII fallback |
|---|---|---|
| done / pass | `✓` | `*` |
| running / in-progress | `▶` | `>` |
| error / fail | `✗` | `x` |
| warn | `⚠` | `!` |
| pending | `○` | `o` |
| spinner | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | `|/-\` |
| tree branch | `├` | `+` |
| tree last | `└` | `\` |
| tree vert | `│` | `|` |
| separator | `·` | `-` |
| ellipsis | `…` | `...` |

Detecção: locale-aware (`LANG`/`LC_ALL` contém `UTF-8`) + check de width via `string-width` em sample. Decide uma vez no boot, cacheia.

### 6.3 Espaçamento

- **Frame margin (UX)**: 2 espaços à esquerda em **todos os elementos visíveis** — banner, scrollback (assistant, tool-end, info/warn/error), status line, tool cards (live + permanent), todo list, slash popover, footer, modal, inverse bar do user-submit (§4.10.8).
  - **Exceção: bloco do input** (régua acima + linha(s) do prompt `> ` + régua abaixo). As 3 linhas formam uma unidade visual e ficam edge-to-edge (col 0 a `cols-1`). Recuar só o input com as réguas padded faria a entrada "vazar" pra fora do frame visual; recuar tudo apagaria a hierarquia ("isto é onde você digita"). Edge-to-edge nas 3 linhas dá um bloco coerente que rompe com o conteúdo recuado acima e com o footer recuado abaixo. O cursor naturalmente cai em col 2 (após `> `), alinhado à margem de 2sp do resto.
  - Largura útil de cada elemento padded é `cols - 2`. Margem direita não existe — alinhar à direita ainda usa col `cols-1`.
- **Indent de conteúdo**: 2 espaços por nível adicional dentro de um elemento (ex.: sub-content connector `└─` sob um chip vai em col 4 = frame margin 2 + nível 2). Não confundir com frame margin (separa conteúdo da borda) vs. indent (separa hierarquia interna).
- Separador horizontal: `─` (Unicode) ou `-` (ASCII). Largura depende do contexto: réguas que cercam o input (acima + abaixo) ficam edge-to-edge (`cols` colunas, sem margin); qualquer outra régua que apareça em scrollback/permanente respeita a frame margin (2sp prefix + `cols - 2` glyphs).
- Linhas em branco entre blocos permanentes: 1 (apenas). Aplica-se também a sub-blocos dentro de um único `PermanentItem` quando a hierarquia visual exige (ex.: banner com 3 sub-blocos, §4.10.9). Nunca 2 ou mais — duplo respiro vira ruído.
- Modais respeitam a frame margin como qualquer outro elemento. (O esboço inicial pré-§4.10.13 dizia "sem padding lateral em modais" — revisto pra coerência visual; modal sem margem destacaria contra o resto recuado e quebraria a leitura).

### 6.4 Tipografia

Terminal só tem uma fonte. Hierarquia vem de:
- `bold` para títulos de modal e ênfase forte (1-2 palavras).
- `dim` para meta (timestamps, paths secundários, hints).
- `default` para tudo o mais.

Combinações proibidas: `bold + dim` (briga visual), `bold + colorido` (exceto `error`).

### 6.5 Densidade

| Contexto | Política |
|---|---|
| Histórico (scrollback) | denso. 1 linha por evento quando possível. |
| Região viva | média. Sumários, não detalhes. |
| Modal | espaçada. Conteúdo + opções, sem ruído. |

---

## 7. Headless mode (`--json`)

Quando `!isTTY` ou flag `--json`: **bus serializa cada evento como NDJSON em stdout**, nada mais.

```jsonl
{"type":"session:start","ts":1735689600000,"sessionId":"abc"}
{"type":"user:submit","ts":1735689601000,"text":"fix bug"}
{"type":"assistant:delta","ts":1735689602000,"text":"Looking..."}
{"type":"tool:start","ts":1735689603000,"id":"t1","name":"read","args":"src/foo.ts"}
{"type":"tool:end","ts":1735689604000,"id":"t1","status":"done","durationMs":120}
{"type":"assistant:end","ts":1735689605000}
{"type":"session:end","ts":1735689606000,"reason":"done"}
```

Garantias:
- **stdout puro.** Nada além de NDJSON. Logs, diagnostics, prompts → stderr.
- **Schema versionado.** `{"v":1, ...}` em `session:start`.
- **Sem prompts interativos.** Permission/trust/memory write em headless: rejeitados por default ou aceitos via `--yes`/policy.
- **Mesmo bus do TUI.** Renderer apenas opcional; bus é a fonte.

Ver `CONTRACTS.md` §2.6 para schemas completos.

---

## 8. Capability detection & fallbacks

Detectado uma vez no boot, cacheado em `caps`:

```ts
interface Capabilities {
  isTTY: boolean              // process.stdout.isTTY
  cols: number                // process.stdout.columns ?? 80
  rows: number                // process.stdout.rows ?? 24
  color: 'none' | '16'        // só 16 cores; sem detecção de truecolor
  unicode: boolean            // locale + sample width check
  hyperlinks: boolean         // OSC 8 — opcional, default off
}
```

Decisões:
- `!isTTY` → headless mode automático (NDJSON).
- `cols < 60` → warning único; segue funcionando.
- `color === 'none'` → todos os escapes ANSI viram no-op.
- `unicode === false` → fallback ASCII em todos os glyphs.
- `hyperlinks` → não usado em v1. Reservado.

Re-detect: `SIGWINCH` atualiza `cols`/`rows`. Demais caps são fixas pela vida da sessão.

---

## 9. Microcopy

### 9.1 Princípios

- **Diga o que aconteceu, onde, e o que decidir.** "Tool X falhou" é ruim. "Tool X (bash) excedeu 30s. Output abaixo. Decisão sua: continuar / cancelar / inspecionar." é UX.
- **Sem desculpa.** Não escreva "Sorry,...". Mostre o problema e a saída.
- **Sem jargão de implementação.** "AbortController disparou" não. "Cancelado pelo user" sim.
- **Imperativo > passivo.** "Run `bun test`" > "Tests should be run".

### 9.2 Catálogo de erros canônico

| Situação | Texto |
|---|---|
| Tool timeout | `tool '<name>' exceeded <Ns>. output above. continue / cancel / inspect?` |
| Tool denied | `tool '<name>' denied by policy: <rule>. edit args / cancel?` |
| Provider down | `provider '<name>' unreachable. retry / switch / cancel?` |
| Budget hit | `step budget hit (<n>/<max>). session ending. /resume to continue.` |
| Trust missing | `unknown directory: <path>. trust to proceed.` |
| Compaction triggered | `context full. compacting last <n> messages…` |

### 9.3 Banidos

- "Oops!", "Sorry!", "Whoops!", "Uh oh!"
- "Loading..." sem indicador de progresso
- "Done!" sem o que foi feito
- Emojis em mensagens funcionais (✓/✗ ok como glyph estrutural)
- Reticências sem ação (`...` final sem indicar próximo passo)

---

## 10. Performance

| Métrica | Budget | Notas |
|---|---|---|
| First paint após `agent` | < 50ms | render do prompt vazio |
| Frame redraw (região viva) | < 16ms p99 | 60fps soft cap |
| Spinner frame interval | 80ms (Unicode) / 100ms (ASCII) | |
| Coalescer de `assistant:delta` | janela de 33ms | múltiplos chunks viram 1 redraw |
| Latência percebida (input → echo) | < 16ms | 1 frame |
| Memory (UI state) | < 5MB | região viva é minúscula |

Ver `PERFORMANCE.md` para SLOs de subsistemas adjacentes.

---

## 11. Testing

### 11.1 Bus-level

Mocka `Bus`, dispara sequência de eventos, assert no estado final do `LiveState`. Cobertura: 100% dos eventos do §3.2.

### 11.2 Render functions

`renderToolCard(state)` e similares são puras. Snapshot tests. ASCII fallback testado igual.

### 11.3 Render integrado

Captura `process.stdout.write` em buffer, dispara eventos, assert no buffer final (com strip-ansi pra readability). Não simula resize / capability detection nesse nível.

### 11.4 E2E TTY

Pty harness (`node-pty`) só pra fluxos que dependem de raw stdin parsing (paste, escape sequences, resize). Mantido pequeno.

---

## 12. Boot sequence

```
1. Parse argv, env, profile.
2. Detect capabilities (caps).
3. Open bus (EventEmitter).
4. If isTTY:
     a. Enable raw mode, bracketed paste.
     b. Install SIGWINCH, SIGINT handlers.
     c. Start renderer (subscribes to bus).
   Else:
     Start NDJSON serializer (subscribes to bus).
5. Bootstrap subsystems (memory, checkpoints, providers, ...).
6. Bus emit `session:banner` (§4.10.9 — em REPL; one-shot pula).
7. Bus emit `session:start`.
8. Loop: read input, dispatch to harness, emit events.
9. Em transição de turno (REPL only): bus emit `step:separator` (§4.10.10).
10. On exit (any path): drain bus, restore stdin mode, cursor visible.
```

Restore de stdin mode é crítico — sem isso, o terminal do user fica em raw mode após crash. Use `process.on('exit'|'SIGINT'|'uncaughtException')` para garantir.

---

## 13. Não-objetivos

- **Mouse support** (clique, scroll). Terminal nativo já scrolla. v2+ se houver demanda.
- **Themes plugáveis.** Paleta é fixa.
- **Layouts split.** Uma coluna, ponto.
- **Painéis fixos** (top bar permanente, sidebar). Tudo é inline.
- **Hyperlinks (OSC 8).** Reservado pra v2.
- **Imagens (Sixel/Kitty graphics).** Fora de escopo.
- **Animações.** Só spinner. Nada de fade, slide, transition.
- **Tabela navegável** (`<Table>` cursor mode). Listas longas viram scrollback; navegação fica em CLI separada (`agent --session`, `agent --memory`).

---

## 14. Insight final

A diferença entre uma TUI agentic boa e ruim não está nos componentes: está no fato de que o terminal é tratado como **um meio**, não como uma tela. Histórico é scrollback do terminal. Cancelamento é Ctrl+C nativo. Cópia é seleção do terminal. Tudo o que o user já sabe fazer com um shell continua funcionando.

Framework de UI tenta resolver problemas que o terminal não tem. A região viva é pequena demais pra justificar React; o histórico é grande demais pra colocar dentro de um framework.

> Inline. Funcional. Pequeno. Boring.
