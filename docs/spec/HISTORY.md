# HISTORY

Subsistema de histórico de inputs do REPL. SQLite-backed, per-project, auditável, com privacy-first opt-out.

History **não é log de conversa**, **não é audit trail de execução**, **não é replay**. É a sequência ordenada de prompts que o operador submeteu, recallable via ↑/↓ e reverse-search (`Ctrl+R`) — convenção que toda shell competente carrega há 30 anos.

> Sem history, o operador refaz o mesmo prompt manualmente toda vez que reabre o REPL. Com history mal feito, secrets vazam pra disco e ficam até o operador limpar manualmente.

---

## 0. Princípios (não-negociáveis)

1. **Per-project, não global.** Histórico de cada `cwd` (resolved via project root, não literal cwd) fica isolado. Trabalhar em `repo-A` e em `repo-B` na mesma máquina nunca cruza prompts.
2. **Append-only no storage.** Edita-se via UI / slash command, nunca via mutação direta no disco. Audit trail implícito (toda escrita é insert com `ts`).
3. **Privacy-first com default explícito.** Default ligado (matching shell convention que o operador conhece), mas com aviso first-run + slash command pra desligar a qualquer momento. Nada de "silently persisted".
4. **Sem cargo cult de busca semântica.** Match exato + substring case-insensitive em `Ctrl+R`. Sem embedding, sem ranking inteligente — substring é suficiente, previsível, e cabe num único query SQL.
5. **Concorrência tolerada, não otimizada.** Múltiplas REPLs no mesmo projeto (terminais paralelos): cada uma append-writes, lê o estado atual no boot. Mudanças feitas em outra REPL viram visíveis na próxima reabertura — visibility lag explícito, sem locking exotic.
6. **Cap durável.** Trim em append quando exceder o limite. Sem "compactar lazily on read" que vira surpresa de latência.
7. **History é readback, não execução.** Recall traz o texto pra buffer; o operador edita / submete deliberadamente. Nada de "auto-rerun" ou expansão `!!` bash-style — `!` é literal no input.

---

## 1. Storage

### 1.1 Tabela

Reutiliza a SQLite db de bootstrap (`.agent/forja.db`). Migration nova adiciona:

```sql
CREATE TABLE repl_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,         -- ms since epoch
  project_root TEXT    NOT NULL,         -- absolute, normalized
  prompt       TEXT    NOT NULL          -- full buffer, including '\n'
);
CREATE INDEX repl_history_by_project_ts
  ON repl_history(project_root, ts DESC);
```

`prompt` carrega o buffer multi-line completo (Shift+Enter / `\`+Enter dão `\n`s; armazena verbatim).

`project_root` é resolvido via `path.resolve(cwd)` e nunca decorado com paths relativos — chaves estáveis através de chdir.

### 1.2 API

`src/storage/history.ts`:

```ts
appendHistory(db, projectRoot, prompt): void
loadHistory(db, projectRoot, limit = HISTORY_CAP): string[]  // oldest-first
clearHistory(db, projectRoot): void
countHistory(db, projectRoot): number
```

- `appendHistory`: insert com `ts = Date.now()`. **Dup-of-last suppression**: se o último entry pra esse `projectRoot` é igual, no-op silencioso. Reduz ruído de submits gêmeos. Após insert, trim se `count > HISTORY_CAP`: `DELETE` do oldest até voltar ao cap.
- `loadHistory`: query `WHERE project_root = ? ORDER BY ts DESC LIMIT ?`, reverse pro consumo (oldest-first matching o sentido de ↑).
- `clearHistory`: `DELETE WHERE project_root = ?`.

### 1.3 Cap

`HISTORY_CAP = 10_000` por projeto. Override via env `FORJA_HISTORY_SIZE=N` (read no boot — mudança não retroage; limpa via `/history clear` ou edição manual da db).

Trim acontece em append, não em load — load é hot path.

### 1.4 Concorrência

Cada REPL faz append-only writes. Não há lock entre janelas abertas. SQLite em WAL mode (já é default da bootstrap db) tolera writes concorrentes.

Visibility entre REPLs: lazy. REPL B só vê entries de REPL A na próxima reabertura (load no boot). Aceito porque history é convenience, não shared state crítico.

Edge case: duas REPLs submetem o MESMO prompt simultaneamente. Ambas inserem (dup-of-last roda contra cada cache local, não contra a db). Resultado: duplicate entry persistido. Não vale criar lock pra isso — o operador apaga via `/history clear` se incomodar.

---

## 2. UI

### 2.1 Navegação por seta — UI.md §5.4

| Tecla | Estado | Ação |
|---|---|---|
| ↑ | input idle | Recall entry anterior. Primeira pressão salva o buffer atual em "scratch"; pressões subsequentes andam pra trás (older). Clamp no oldest. |
| ↓ | input idle | Recall entry mais recente. Ao passar do newest, restaura scratch. |

**Scratch**: buffer que o operador estava digitando ANTES de começar a navegar. Preservado na primeira ↑ e restaurado quando ↓ retorna ao "presente". Sem scratch, navegar perde o draft.

**Cursor pós-recall**: ponta final do buffer (`buffer.length`). Operator edita normalmente; setas horizontais movem dentro do recalled.

**Slash mode tem precedência**: se o popover de slash command está aberto (state.slash !== null), ↑/↓ navegam o popover, não o history. Coerente com toda shell que tem completion popover (zsh, fish).

**Modal aberto**: ↑/↓ vão pro modal (que tem seu próprio handler). History não compete.

**Submit reset**: ao emitir `user:submit`, `historyIdx` volta a `null` e `scratch` esvazia. A próxima ↑ recomeça do entry mais recente (que é justamente o que o operador acabou de submeter).

### 2.2 Reverse search — `Ctrl+R`

Já listado em UI.md §5.4. Layout próprio (§4.10.X — preencher quando o slice landar):

```
  (reverse-i-search)`que`: como rodar bun em watch?
```

- Aparece OVER o input box (não substitui — operator vê seu draft preservado abaixo, dim).
- Match: substring case-insensitive contra `prompt` da history, ordenado por `ts DESC` (mais recente primeiro).
- Digitar adiciona à query; backspace remove.
- `Ctrl+R` repetido cicla pra entries mais antigas com a mesma query.
- `Enter` aceita: substitui buffer pelo match e submita.
- `Tab` aceita pra edição: substitui buffer pelo match, fecha overlay, cursor no fim. Operator edita e Enter quando quiser.
- `Esc` cancela: fecha overlay sem mudar buffer.
- Sem matches: query continua editável, mas linha mostra `(reverse-i-search)\`xyz\`: <empty>` em dim.

**Não é busca semântica.** Substring exato. Pra prompts longos com palavras-chave únicas, basta. Embedding-based search seria 1000× a complexidade pra ganho marginal.

### 2.3 Slash command `/history`

`src/cli/slash/commands/history.ts`:

| Forma | Ação |
|---|---|
| `/history` | Imprime resumo: `42 entries · cap 10000 · /history list to view, /history clear to wipe` em info-line. |
| `/history list` | Imprime as últimas 20 entries em scrollback (info), oldest-first dentro do bloco. Cada linha: `<ts shortform> · <prompt truncado a 1 linha>`. |
| `/history clear` | Modal de confirm (3 opções: Yes / Yes (and disable persistence) / No, default No). `/history clear --yes` skip modal pra automation. |
| `/history off` | Desliga persistência **por session** (volátil): submits posteriores não escrevem. Re-ligar com `/history on`. |
| `/history on` | Re-liga persistência (default). |

`/history off` afeta APENAS a REPL atual. Pra desligar permanentemente, env `FORJA_NO_HISTORY=1`.

---

## 3. Privacy

### 3.1 Default-on

Persistência ligada por default. Razões:
- Match com shell convention (bash/zsh/fish todos persistem por default).
- Maior parte do uso é benigna — operadores não digitam `OPENAI_API_KEY=...` no prompt do agente; falam de código.
- Opt-in seria uma feature que ninguém liga porque ninguém descobre.

### 3.2 First-run banner

Na primeira REPL com history populando, info-line:

```
  history: persisted to .agent/forja.db (10000 entry cap)
           /history off to disable for this session, /history clear to wipe
```

Marker em `.agent/forja-history-acked` (per-project): se existir, banner suprimido. Operator que já leu uma vez não revê toda REPL.

### 3.3 Opt-out

Três níveis:
1. **Permanente, global**: `FORJA_NO_HISTORY=1` no env. Storage layer no-op em append/load.
2. **Permanente, por projeto**: `.agent/no-history` (file marker) — também desabilita.
3. **Por session**: `/history off` durante a REPL.

Ordem de precedência: env > file marker > slash toggle (mais alto vence).

### 3.4 Secrets na prática

History pode persistir prompts contendo tokens / paths / strings sensíveis. **A spec não tenta detectar isso** — heurística falha em ambos os lados (regex de "API_KEY" perde tokens não rotulados; agressivo demais censura conteúdo benigno).

Posture: documentar claramente, expor opt-out fácil. Se um operador colar `sk-proj-...` no prompt, history vai conter — e o `.agent/forja.db` é local, não sincronizado, default-gitignored (ver §3.5).

### 3.5 Filesystem hygiene

`.agent/` deve estar no `.gitignore` global do projeto. Bootstrap já adiciona quando inicializa em repo limpo (§AUDIT). Operadores trabalhando em repo já-iniciado precisam confirmar manualmente — banner de privacy menciona explicitamente.

---

## 4. Cross-cutting

### 4.1 Multi-line prompts

Buffers com `\n` (Shift+Enter / `\`+Enter, ver UI.md §5.4) são persistidos verbatim. Recall via ↑ traz o buffer multi-line completo de volta. Reverse-search match roda contra o conteúdo total (operator pode buscar palavra que está na 3ª linha de um prompt antigo).

Slash list: trunca cada entry pra 1 linha visual no display, com `…` indicando overflow.

### 4.2 Audit / messages table

`repl_history` é independente da `messages` table (a que armazena conversation context pra resume). Decisão deliberada:
- `messages` é estado da sessão (system + user + assistant + tool roles, em ordem de turno).
- `repl_history` é fila de prompts (só user-submit, sem assistant text, sem turn metadata).

Reusar `messages` exigiria filtrar `WHERE role='user'` E reconstruir a noção de "submission" (user pode ter múltiplos message blocks dentro de um turn). Coluna duplicada salva uma JOIN complexa por queries da history, e a vida de cada um é diferente (resume é por session; history é por project).

### 4.3 Resume não popula history

`/agent --resume <session>` carrega `messages` pra continuar a conversa. **Não** popula `repl_history` retroativamente — entries da sessão antiga já estão na history (foram persistidos no momento de submit). Sem dupla.

### 4.4 Headless mode

`agent -p "..."` (one-shot, não-REPL) **não escreve history**. History é per-REPL; one-shot é pipeline mode.

`agent --resume` em modo non-REPL (raro) idem.

---

## 5. Implementação — referências

| Slice | Arquivo | Estimativa |
|---|---|---|
| Migration | `src/storage/migrations/<NNN>_repl_history.sql` | 1 arquivo SQL + bump na list de migrations. |
| Storage API | `src/storage/history.ts` | ~120 linhas + ~150 de tests. |
| REPL nav (↑/↓ + scratch) | `src/cli/repl.ts` | +120 linhas + ~150 de tests. |
| Reverse-search widget | `src/tui/render/reverse-search.ts` + focus stack handler | ~200 linhas + ~100 de tests. |
| Slash `/history` | `src/cli/slash/commands/history.ts` | ~80 linhas + ~80 de tests. |
| Privacy banner | bootstrap.ts hook | ~40 linhas + ~40 de tests. |

Total estimado: ~700-900 linhas de código + ~600 de tests. ~3 dias.

---

## 6. Não-objetivos

- **Busca semântica** (embedding match em prompts antigos). Substring é suficiente.
- **History expansion** (`!!`, `!N`, `!prefix:s/old/new/`). Ambíguo com `!` literal em prompts; ↑ + edit cobre o caso real.
- **Sync entre máquinas** (cloud history). Local-only por design — privacy + simplicity.
- **History compartilhado entre projetos**. Per-project isolado é a posição da §0.
- **Edição inline de entries**. History é append-only; operator quer alterar = limpa + redigita.
- **Smart auto-suggestions** estilo fish (history-based completion enquanto digita). Pode entrar como extensão futura, não no core.

---

## 7. Cross-references

- `UI.md §5.4` — keybindings de ↑/↓ e Ctrl+R já listadas; este doc explicita o comportamento.
- `UI.md §4.10.X` (a definir) — layout do reverse-search widget quando o slice landar.
- `AGENTIC_CLI.md §17` — REPL principles (TBD: cross-ref pra "history como UX baseline").
- `SECURITY_GUIDELINE.md` — secrets posture (TBD: cross-ref pra "history is local + .gitignored").
- `AUDIT.md` — `repl_history` table não conta como audit trail (audit é em `audit_events`).
