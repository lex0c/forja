---
name: respect-repo-conventions
description: convenções vêm do repo (git log, configs), nunca de defaults genéricos
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Convenção de commit message, lint, format, naming e estrutura de
arquivo vem do repo — `git log`, configs existentes, arquivos
adjacentes — nunca de default genérico do agente.

**Why:** convenções genéricas (Conventional Commits, Prettier
defaults, "use kebab-case porque AI") frequentemente conflitam com a
convenção real do repo. Aplicar convenção errada cria churn (diff
cheio de mudanças cosméticas não pedidas), atrapalha code review,
e sinaliza falta de atenção ao contexto. `git log` revela o estilo
do repo em segundos.

**How to apply:**
- Antes de propor mensagem de commit: `git log --oneline -20` pra
  inferir formato (Conventional Commits? Title Case verbo? lowercase?
  com scope? sem?)
- Lint/format: respeitar configs presentes (`.eslintrc`, `.prettierrc`,
  `.editorconfig`, `ruff.toml`, `rustfmt.toml`) — não impor
  formatação não configurada
- Naming: ler nomes próximos no diretório, não impor convenção por
  linguagem
- Estrutura de arquivo novo: casar com pares do mesmo diretório
- `CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING.md` no repo: ler antes de
  propor mudança que toque convenção
- Se convenção do repo é ruim por critério externo: apontar ao user
  separadamente, **não** corrigir de surpresa no PR
