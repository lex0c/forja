# Checkpoints & Rollback — Design Doc

Concretiza o spec §12 (`AGENTIC_CLI.md`) decidindo as questões que o
texto de alto nível deixa em aberto. Princípio 10 ("reversível por
design") ganha cobertura real ao implementar este doc; sem ele, o
spec promete `/undo` mas o código não tem nada equivalente.

## 1. Premissa não-negociada

- Todo step do harness que executa tool com `writes: true` cria um
  snapshot **antes** da execução.
- Snapshot referencia o estado pré-step. `/undo` restaura para o
  snapshot anterior.
- Mecanismo invisível ao git normal do usuário.
- **Escopo = worktree inteiro.** Snapshot e restore operam ancorados
  no `git rev-parse --show-toplevel`, não no diretório de invocação.
  Rodar o agente de um subdiretório do repo NÃO encolhe o snapshot
  para aquela subárvore — captura/restaura o worktree todo. Ver §2.6.
- Side effects fora do filesystem (DB, network, processos) **não**
  são revertidos — limite explícito, não bug. Idem arquivos fora do
  worktree (outro repo, `/tmp`, `$HOME`).

## 2. Decisões abertas

### 2.1 Granularidade

**Pergunta:** snapshot por step (modelo emite N tool_uses, snapshot
único antes da primeira write) ou por tool (snapshot por write)?

**Proposta:** **por step**. Modelos chamam várias writes em sequência
para uma operação lógica (refactor de 5 arquivos = 5 edits do mesmo
step); revertir parcialmente deixa estado inconsistente. Spec §12.1
já indica "step", confirmamos.

**Trade-off:** `/undo` reverte mais do que estritamente necessário em
edge cases (1 das 5 writes deu ruim → perde as outras 4 que estavam
OK). Aceitável: o usuário pode re-executar o que quer manter.

### 2.2 Backend: git vs não-git

**Pergunta:** suportar fallback `cp --reflink` em FS sem git, ou
v1 é git-only?

**Proposta:** **git-only em v1**. Detecta `.git` no cwd; se ausente,
checkpoints ficam **desabilitados** com aviso `--checkpoints not
available (cwd is not a git repository)` no startup. Tools com
`writes: true` rodam normalmente; só não há `/undo`.

**Trade-off:** usuários em diretórios genéricos perdem reversibilidade.
Aceitável porque (a) target primário é repos de código, (b)
`cp --reflink` tem dependências de FS (btrfs/xfs/apfs) que cortam
~50% dos usuários ext4, (c) v2 pode adicionar.

### 2.3 UX pré-TUI

**Pergunta:** slash commands (`/undo`, `/checkpoint list`) dependem
da TUI (M4). O que existe pré-M4?

**Proposta:** flags equivalentes no CLI:

```
agent --checkpoints list <session-id>
agent --checkpoints diff <session-id> <checkpoint-id>
agent --undo <session-id>                     # reverte último
agent --checkpoints restore <session-id> <checkpoint-id>
```

Slash commands ganham wire em M4 mapeando para a mesma API interna.

**Trade-off:** sintaxe verbosa pré-M4. Aceitável; usuário típico
de M3 já roda CLI.

### 2.4 Storage layout

- Cada checkpoint é um **commit** em ref dedicada
  `refs/agent/checkpoints/<session_id>`. NÃO é stash (stashes são
  uma única ref `refs/stash` que empilha; usar ref própria por
  sessão dá histórico independente, retain control, e não polui
  o stash do usuário).
- Cada commit tem mensagem
  `forja: pre-step <step_n> <iso-timestamp>` para grep humano.
- Tabela DB nova `checkpoints`:
  ```
  id            TEXT PRIMARY KEY
  session_id    TEXT FK
  step_id       TEXT FK messages.id
  git_ref       TEXT NOT NULL  -- commit sha
  created_at    INTEGER NOT NULL
  had_bash      INTEGER NOT NULL  -- 1 se step incluiu bash, 0 senão
  ```
  `had_bash` permite o aviso de "side effects não revertem" em
  `/undo` sem reler o tool_calls.

### 2.5 Cleanup

**Pergunta:** quando expiram?

**Proposta:**

- Refs vivem até **30 dias** após `ended_at` da sessão
  (configurável via `agent.checkpoints.retentionDays`).
- Cleanup roda **lazy** no startup do agent (varre refs órfãs).
  Não bloqueia, melhor-esforço.
- `agent --checkpoints purge <session-id>` força.

**Trade-off:** disk usage no curto prazo. Em sessões pequenas
(<50 steps), uma stash gira em torno de KB-MB; em monorepo
grande, pode crescer. Documentar.

### 2.6 Escopo do snapshot/restore — worktree inteiro

**Pergunta original:** o checkpoint cobre só o diretório de invocação
(cwd) ou o worktree inteiro? Um step que edita dentro do cwd E roda
bash que escreve em `/tmp` — o que `/undo` reverte?

**Decisão (revisada):** **worktree inteiro, ancorado no toplevel.**
A proposta inicial era cwd-only, mas a implementação convergiu para
worktree-wide pela seguinte razão de consistência: o restore usa
`git read-tree --reset -u <commit>`, que é **sempre** worktree-wide
(reescreve o índice + working tree inteiros, não há forma barata e
segura de escopá-lo a uma subárvore com deleção de arquivos novos).
Um snapshot cwd-scoped (`git add -A .` a partir de um subdiretório
captura só aquela subárvore) contra um restore worktree-wide produz
uma **assimetria com perda silenciosa**: paths fora do cwd entram no
checkpoint no estado de HEAD (não no estado real do momento), e o
`/undo` os reseta para esse HEAD descartando mudanças intermediárias
(recuperáveis na stash, mas surpresa).

Para fechar isso, snapshot, diff e restore resolvem o worktree root
via `git rev-parse --show-toplevel` uma vez (no probe de
`detectCheckpointSupport`) e operam a partir dele. Rodar de um
subdiretório passa a ser indistinguível de rodar da raiz.

O que continua **fora** de escopo (o `had_bash` warning cobre):

```
WARNING: this step ran bash. /undo reverts filesystem changes
within the git worktree, but cannot reverse:
  - Database / HTTP / network state changes
  - Filesystem changes outside the worktree (/tmp, $HOME, other repos)
  - Process spawns
Type 'undo' to confirm.
```

`had_bash` na tabela checkpoints serve esse warning.

**Trade-off:** (a) o snapshot é sempre worktree-wide, então em
monorepo o `git add -A` cobre tudo — mitigado pelo skip-on-noop
(§2.8) e dentro do SLO para repos < 10k arquivos. (b) `/undo` toca
arquivos fora do cwd de invocação (mas dentro do worktree); como o
restore já era worktree-wide em runtime, isto descreve o
comportamento real, não o expande. Prompt extra atrasa um pouco;
aceitável: melhor que falsa segurança.

### 2.7 Conflito com git do usuário

**Pergunta:** usuário commita arquivo X, agente edita X em step S,
usuário commita de novo. `/undo S` quer restaurar X pré-edit, mas
o working tree tem mudanças não-commitadas do usuário.

**Proposta:** `/undo` faz `git stash push -u` do working tree
ATUAL antes de aplicar o checkpoint, e instrui o usuário a usar
`git stash pop` se quiser as mudanças de volta. Mensagem:

```
Working tree had uncommitted changes; pushed to stash@{0}.
Restored to checkpoint <id>. Run `git stash pop` to recover
the changes if you need them.
```

**Trade-off:** o usuário precisa entender. Documentado in-tool.

### 2.8 Performance

**Pergunta:** monorepo de 100k arquivos. Snapshot pré-step demora.

**Proposta:**

- Snapshot usa `git add -A && git commit-tree` (não `git stash`)
  — reusa index existente, é o caminho mais rápido pra criar
  commit no git. As invocações git rodam ancoradas no worktree
  root (§2.6), então o `add -A` cobre o repo inteiro de forma
  determinística independente do subdiretório de invocação.
- Skip se não houve writes desde o último checkpoint
  (verificado via `git diff --quiet`).
- Métrica `checkpoint_create_ms` no telemetry (`PERFORMANCE.md`).
  SLO: p95 < 500ms em repos típicos (<10k arquivos).

**Trade-off:** monorepos extremos podem exceder. Documentado.

## 3. API interna (TS)

```ts
interface CheckpointManager {
  // Antes de cada step com writes. Retorna o id do checkpoint
  // criado, ou null se cwd não é git (modo desabilitado).
  snapshot(stepId: string, hadBash: boolean): Promise<string | null>;

  // Lista checkpoints da sessão (newest first).
  list(sessionId: string): Promise<Checkpoint[]>;

  // Restaura para um checkpoint específico. Throws se git
  // working tree tiver conflito não-resolvido.
  restore(checkpointId: string): Promise<{
    stashed: boolean;          // working tree teve mudanças?
    stashRef?: string;          // stash@{N} para o usuário recuperar
  }>;

  // Diff entre estado atual e checkpoint.
  diff(checkpointId: string): Promise<string>;

  // Cleanup de refs órfãs / expiradas.
  purge(opts?: { sessionId?: string; olderThanDays?: number }): Promise<number>;
}
```

## 4. Out of scope (v1)

- Backend não-git (cp --reflink). Pull-in: usuário em diretório
  não-git pede o feature.
- Checkpoints automáticos por tempo (snapshot a cada N minutos).
- Branching de checkpoints (fork de uma sessão a partir de um
  checkpoint). Pull-in: caso de uso real.
- Diff visual no TUI (M4).

## 5. Critério de aceitação

1. ✅ Step com `writes: true` cria checkpoint registrado em `checkpoints`.
2. ✅ `agent --undo <session>` restaura último; tabela atualizada.
3. ✅ Cwd sem .git: warning na startup, `--undo` retorna erro claro.
4. ✅ `--undo` em step com `had_bash: true` exige confirmação.
5. ✅ Working tree dirty no momento do undo é stashed + reportado.
6. ✅ Smoke real: agente faz refactor de 3 arquivos, `--undo`
   restaura para pré-refactor.
7. ✅ Performance: 10k-arquivo repo, snapshot < 500ms p95.
8. ✅ `--checkpoints purge --older-than 30` limpa refs antigas.

## 6. Estimativa

- **MVP (questões 2.1-2.6 + API):** 5-7 dias de trabalho focado.
- **+ cleanup + warnings + smoke:** +2 dias.
- **+ slash commands na TUI (M4):** depende do M4 inteiro.

Comparação com Step 2.4 (resume): subsistema mais novo, mais
git-internals, mais arestas (working tree state, ref namespacing,
cleanup). Esperar **2x o effort do resume** — ~2 semanas reais
considerando rodadas de review consistentes com o histórico.
