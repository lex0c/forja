# Output policy

Como Forja minimiza o peso de tool outputs grandes no contexto sem perder fidelidade no audit. Cross-ref `CONTEXT_TUNING.md §6` (compaction, que opera no nível da mensagem) e `TOOL_ERGONOMICS.md` (como o modelo escreve args; concern diferente).

## 0. Princípios (não-negociáveis)

1. **Audit nunca perde fidelidade.** A coluna `tool_calls.output` sempre guarda o resultado RAW retornado por `tool.execute()`. Toda redução acontece DEPOIS desse persist, no caminho que produz o `tool_result.content` do modelo.
2. **Sumarizadores são puros.** Sem I/O, sem clock, sem provider call. Replay re-aplica o mesmo summarize sobre o RAW do audit e produz o mesmo digest.
3. **Modelo recebe sinal explícito.** Quando reduzimos, prependamos um marker `[forja:output_summarized policy=X original_bytes=N]` no content. Modelo sabe que está lendo digest e pode re-invocar com args mais estreitos.
4. **Path de erro nunca é summarizado.** ToolError shapes são pequenas por construção e load-bearing verbatim (error_code, error_message, hint, details). Harness roteia esses pela permanent-path que não chama `summarize`.

## 1. Surface no `ToolMetadata`

Tools que podem produzir output > dezenas de KB declaram um summarizer opcional:

```ts
interface ToolMetadata {
  // ... outras flags
  summarize?: (result: unknown, args: Record<string, unknown>) => SummarizedOutput;
}

interface SummarizedOutput {
  result: unknown;       // mesmo shape do raw — só campos pesados encolhem
  reduced: boolean;      // false = passthrough, harness não emite marker
  originalBytes: number; // bytes do raw (antes de reduzir) — vai no marker
  policy: string;        // label livre — produtor + consumidor compartilham strings
}
```

Tools sem `summarize` declarado são passthrough completo (sem marker, sem redução). Não há fallback genérico aplicado universalmente — o opt-in é per-tool.

## 2. Pipeline no harness

`src/harness/invoke-tool.ts` (success path):

```
1. result = sanitizeToolOutput(rawResult)               (ANSI strip — pre-existente)
2. finishToolCall(output: result)                       ← RAW persiste no audit
3. summary = tool.metadata.summarize?(result, args)     ← opcional
   se summary?.reduced:
     resultForModel = summary.result
     marker = `[forja:output_summarized policy=${summary.policy} original_bytes=${summary.originalBytes}]`
4. content = JSON.stringify(resultForModel ?? result)
5. content = marker ?? '' + content                     ← prepend quando reduzido
6. tool_result.content = content + hook-context blocks
```

Garantias do pipeline:
- **Throw é seguro.** `summarize` que lança vira no-op com log em `stderr`; harness segue com o raw como conteúdo.
- **Idempotência.** Mesmo raw → mesmo digest → mesma content string. Replay reconstrói exatamente.
- **Audit precede modelo.** `finishToolCall` executa ANTES do `JSON.stringify(resultForModel)`. Crash entre os dois deixa o raw persistido — não há janela onde modelo viu digest mas audit ficou sem raw.

## 3. Políticas determinísticas (Tier 1)

São funções puras em `src/tools/output-summarizer.ts` + summarizers inline em cada builtin.

### 3.1 `head_tail` — bash, glob (array de paths)

Quando `bytes > maxBytes`:
- **Caminho many-lines:** keep first `headLines` + last `tailLines` + marker `[... N lines elided (KB dropped) ...]`.
- **Caminho one-giant-line (base64, hex):** keep ~half de `maxBytes` no início + ~half no fim + marker `[... NkB dropped ...]`. Sem isso, line-based head/tail não reduziria nada num blob.

Per-tool tuning:
| Tool | Threshold | Head + tail | Comentário |
|---|---|---|---|
| `bash` (stdout) | 16 KB | 80 + 80 linhas | Aplicado independente do stderr |
| `bash` (stderr) | 16 KB | 80 + 80 linhas | Não concatenar; operadores leem streams separados |
| `glob` (matches array) | 200 items | 50 head + 50 tail | Ordem alfabética torna head/tail informativos |
| `task_sync` / `task` (`output`) | 16 KB | 80 + 80 linhas | Texto final do child; raw completo permanece no audit do parent e é recuperável via `session_id`. O path de erro (status≠done) trunca `details.output` inline (summarize não roda em erro, §0.4) |

### 3.2 `group_by_file` — grep

Quando `matches.length >= 50`, fold para uma entry por arquivo:

```ts
{ file: string, count: number, firstLine: number, firstText: string }
```

Modelo perde o contexto de linha individual em troca da informação "quais arquivos contêm o pattern", que costuma ser o que ele precisa. Se a linha específica importa, o modelo re-greppea com path mais estreito.

### 3.3 `noop`

Reservado pra quando o tool declara `summarize` mas o input está abaixo do threshold. `reduced: false`, harness não emite marker.

## 4. Marker no `tool_result.content`

Forma: `[forja:output_summarized policy=<label> original_bytes=<N>]\n<JSON do resultForModel>`.

Coexiste com outros markers já documentados (`AGENTIC_CLI.md §9.3` injection scanner):
- Ordem: summarize marker PRIMEIRO (descreve o shape do body), depois injection marker (avisa sobre conteúdo) se aplicável, depois hook-context blocks.
- Razão da ordem: summarize é metadata sobre o body inteiro; injection é warning sobre conteúdo; hooks são context externos. Modelo lê top-down.

Modelo deve usar o marker como sinal pra:
- Re-invocar a tool com args mais estreitos quando perdeu detalhe load-bearing.
- Não assumir que o que vê é o output completo.

Modelo NÃO precisa preservar o marker em respostas subsequentes — é só um aviso transitório no input.

## 5. Replay safety

Replay (de uma sessão persistida) re-executa o pipeline:
1. Lê `tool_calls.output` (RAW) do DB.
2. Re-chama `tool.metadata.summarize(raw, args)` (mesma função pura, mesmo input).
3. Reconstrói `tool_result.content` idêntico ao que o modelo viu em produção.

Não-determinismo no summarizer (clock, I/O, random) é **proibido pela invariante 0.2** — testes do summarizer pinam isso.

## 6. Quando NÃO usar summarize

- Tools cujo output é per-design pequeno (read_file paginated, memory_*, skill_*, todo_write, task_async / task_await / task_cancel / task_list): adicionar summarize seria overhead em vazio. Não declarar.
- **Exceção: `task_sync` / `task`.** O envelope é pequeno em escalares (session_id, status, cost, steps), mas o campo `output` carrega o texto final do child — que pode chegar ao teto de output-tokens do child e é re-enviado a cada turno do parent (write cost). Declara `summarize` (head_tail sobre `output`); o raw completo permanece no `tool_calls.output` do parent (§0.1) E no run do child (recuperável via `session_id`). O path de erro (status≠done) trunca `details.output` inline, porque o harness não roteia erros por `summarize` (§0.4) — mantém o shape do erro pequeno por construção sem perder o ponteiro `session_id`.
- Outputs estruturados onde TODO campo é load-bearing (e.g., `task_async` retorna handle + metadata pequenos). Reduzir corromperia o contrato.
- ToolError, como já dito — o harness roteia separado.

## 7. Limites declarados

- **Cortes determinísticos podem esconder sinal no meio.** Stack trace de 200 frames onde o frame causal está no índice 100: head+tail erra. Mitigação atual: audit retém raw + marker avisa modelo. Mitigação futura: Tier 2 com LLM summarizer (Haiku) opt-in pra cenários onde determinístico perde sinal. **Não shipped.**
- **Modelo pode ignorar o marker.** Sem enforcement. Risco residual; mitigado por qualidade do modelo.
- **Thresholds são empiricos** (16 KB / 50 hits / 200 matches). Tunados sem dado de produção. Configurabilidade per-tool ou via config TOML é follow-up.

## 8. Como adicionar política nova

1. Crie helper puro em `src/tools/output-summarizer.ts` se a forma é reusável; senão escreva o summarizer inline no tool builtin.
2. Wire `metadata.summarize` apontando pro summarizer.
3. Escolha um `policy` label (free-form string) que descreve a forma (`head_tail`, `group_by_file`, `structure_fingerprint`, …).
4. Testes: passthrough (input pequeno → `reduced: false`), reduction (input grande → `reduced: true` + policy label correto), preserve scalars (campos non-heavy mantidos).
5. Marker é emitido automaticamente pelo harness com base no `policy` + `originalBytes` retornados — não há código no tool pra escrever marker.
