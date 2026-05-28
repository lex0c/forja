---
name: git-first-orientation
description: sessão fresca em repo git começa por git status + git log -10
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Em sessão fresca em repo git, começar com `git status` +
`git log --oneline -10` antes de explorar o FS. Tratar git como
primitiva de navegação temporal/causal, não só de versionamento.

**Why:** `ls`/`glob` mostra estrutura mas não direção. `git status` +
`git log -10` revelam em ~200ms: o que está em curso, o que mudou
recentemente, qual o eixo de trabalho atual. Sem essa orientação, o
agente gasta tokens explorando código que pode ter sido refatorado
ou removido na semana passada. Bugs frequentemente vêm de mudança
recente; `git log -S`, `git bisect`, `git blame -L` cortam espaço
de busca exponencialmente vs. grep cego.

**How to apply:**
- Sessão fresca em repo git: rodar `git status` + `git log --oneline -10`
  antes de qualquer exploração de estrutura
- "Onde está X?" muitas vezes é "X foi tocado recentemente —
  `git log -p --follow path/X`"
- Investigação de bug: começar por `git log --since=<range>` ou
  `git log -S "fragmento da mensagem de erro"`
- "Por que essa linha existe?" → `git blame -L start,end file`
- "Quem entende essa área?" → `git log --format=%an path/ | sort -u`
- Fallback: repo sem história significativa (squash extremo, fresh
  shallow clone) perde essa primitiva — cair pra navegação espacial
