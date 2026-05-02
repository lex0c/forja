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
4. Escreve em uma única `process.stdout.write(...)`.
5. Reposiciona cursor dentro do input.

Frame budget: **30fps soft, 60fps em bursts** (ver `PERFORMANCE.md`). Coalescer eventos dentro de um frame: vários `assistant:delta` em < 33ms viram um único redraw.

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
| `session:start` | Início da sessão | imprime cabeçalho permanente |
| `session:end` | Fim da sessão | imprime sumário permanente |
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

```
[autonomous] · forja · sonnet-4.6 · 12/50 · $0.04 · mem 4u · bg 1
```

Componentes (esquerda → direita):
- `[profile]` (vazio se default)
- nome do projeto (basename do repo root)
- modelo
- steps (`12/50`, `⚠ 40/50` se ≥ 80%, `‼ 48/50` se ≥ 90%)
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

---

## 5. Padrões de interação

### 5.1 Input handling

- `process.stdin.setRawMode(true)` no boot (TTY only). Restore em qualquer exit path (incl. Ctrl+C, exceptions).
- Parser de escape sequences manual: setas, Home/End, Delete, Ctrl+A/E/U/W/K, Alt+B/F (word jumps), Ctrl+Backspace, Enter, Shift+Enter.
- **Bracketed paste** (`\x1b[200~...\x1b[201~`): habilitado no boot, processado em batch (sem disparar redraw por char).
- Histórico de input: persistido em `<repo>/.agent/state/input-history.txt` (últimas 1000 entradas), navegável com seta-pra-cima/baixo. Ctrl+R = reverse search.
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
| Ctrl+C | running | cancela step atual (graceful) |
| Ctrl+C (2x) | running | hard kill |
| Esc | running | request soft interrupt (LLM termina passo, depois para) |
| Esc Esc | running | hard interrupt (cancela tool em curso) |
| Ctrl+L | qualquer | clear screen (mantém histórico no scrollback) |
| Ctrl+R | input | reverse search no histórico |
| Ctrl+D | input vazio | exit |
| Tab | input com `/` | autocomplete |
| Ctrl+Z | qualquer | suspend (SIGTSTP), retorna com `fg` |
| ↑/↓ | input | navegar histórico de inputs |

### 5.5 Modal pattern (canônico)

Modal **não é popup**. É:

> estado + handler no topo da focus stack + promise.

Sem framework. Sem reconciler. Sem componentes reutilizáveis.

#### Estado

```ts
interface ConfirmState {
  message: string
  details?: string[]
  selected: 'yes' | 'no'
  defaultsTo: 'no'         // safety: default sempre 'no'
  timeoutMs?: number        // opcional; ausente = sem timeout
}

let confirm: ConfirmState | null = null
let resolveConfirm: ((v: boolean) => void) | null = null
```

#### Render (substitui o input dentro da região viva)

```ts
function renderConfirm(c: ConfirmState): string[] {
  return [
    '─────────────────────────────────────────',
    `  ${c.message}`,
    ...(c.details?.length ? ['', ...c.details.map(d => `  ${d}`)] : []),
    '',
    `  ${c.selected === 'yes' ? '▶ YES' : '  YES'}    ${c.selected === 'no' ? '▶ NO' : '  NO'}`,
    '─────────────────────────────────────────',
  ]
}
```

Modais substituem **o input**, não o histórico. Status line continua. `composeLive(state)` chama `renderConfirm()` em vez de `renderInput()` quando `confirm !== null`. Não há "overlay" sobre o histórico — região viva é dona dela mesma.

#### Focus handler (push no topo da stack)

```ts
pushFocus(key => {
  if (!confirm) return false
  if (key === 'left' || key === 'right' || key === 'tab') {
    confirm.selected = confirm.selected === 'yes' ? 'no' : 'yes'
    return true
  }
  if (key === 'enter') {
    const result = confirm.selected === 'yes'
    confirm = null
    popFocus()
    resolveConfirm!(result)
    return true
  }
  if (key === 'escape') {
    confirm = null
    popFocus()
    resolveConfirm!(false)
    return true
  }
  return true  // bloqueia o resto enquanto modal ativo
})
```

#### API async

```ts
function askConfirm(message: string, details?: string[], timeoutMs?: number): Promise<boolean> {
  return new Promise(resolve => {
    confirm = { message, details, selected: 'no', defaultsTo: 'no', timeoutMs }
    resolveConfirm = resolve
    if (timeoutMs) {
      setTimeout(() => {
        if (confirm) { confirm = null; popFocus(); resolve(false) }
      }, timeoutMs)
    }
  })
}
```

Uso:

```ts
const ok = await askConfirm('Apply changes?', ['3 files will be modified'])
if (ok) await applyDiff()
```

#### Regras (não-negociáveis)

1. **Default = NO.** `selected` inicia em `'no'`. Enter sem navegar = rejeita. Salva muita unha.
2. **Highlight com seta** (`▶ YES`), não cor sólida. Cor só em status final (verde após accept, vermelho após reject) — opcional.
3. **Bloqueio total do input normal** enquanto modal ativo. O `return true` no fim do handler garante que tecla nenhuma vaza pra baixo na focus stack.
4. **Largura fixa** com `padEnd` em todas as linhas internas. Sem isso, ANSI errado quebra o redraw.
5. **Sem reflow durante input.** Resize (SIGWINCH) durante modal: reposiciona, não reflua texto.
6. **Timeout opcional, default rejeita.** `permission:ask` sem timeout (espera o user). `trust:ask` com 5min (rejeita pra read-only). Plan review sem timeout.
7. **Re-render mínimo.** Mudança de `selected` redesenha só a região viva, nunca o histórico.

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
| `dim` | meta, hints, separadores | `\x1b[2m` |
| `bold` | ênfase, header de modal | `\x1b[1m` |
| `error` | mensagens de erro, status falho | `\x1b[31m` |
| `warn` | avisos, budget 80% | `\x1b[33m` |
| `success` | apenas em pipeline badges (`✓`) | `\x1b[32m` |

**Sem mais cores.** Sem azul, sem ciano, sem magenta, sem gradientes, sem 256-color, sem truecolor. Profile/model/etc. ficam em `default`. Se você precisa de cor pra distinguir, o layout falhou.

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

- Indent fixo: 2 espaços por nível.
- Não há padding interno em modais (linhas vazias acima/abaixo do conteúdo, sem espaços laterais — borda fica em `─`).
- Separador horizontal: `─` (40 chars) ou `-` (ASCII).
- Linhas em branco entre blocos permanentes: 1 (apenas).

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
6. Bus emit `session:start`.
7. Loop: read input, dispatch to harness, emit events.
8. On exit (any path): drain bus, restore stdin mode, cursor visible.
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
