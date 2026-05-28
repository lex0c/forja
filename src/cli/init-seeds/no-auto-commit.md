---
name: no-auto-commit
description: nunca criar commit sem pedido explícito do user
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Nunca criar git commit sem pedido explícito do user. Sugerir mensagem
de commit; executar `git commit` só se user pedir.

**Why:** user controla o histórico do repo manualmente; auto-commits
poluem `git log`, baguncam batching de mudanças relacionadas, podem
incluir arquivos não intencionais (`.env`, credenciais, build
artifacts), e tiram do user a decisão de quando/como agrupar
mudanças. "Acabei de editar 3 arquivos, vou commitar" parece útil,
mas remove controle.

**How to apply:**
- Após editar arquivo(s): **não** rodar `git commit` automaticamente
- Ao terminar série de mudanças, sugerir mensagem de commit no
  formato do repo (vem de `respect-repo-conventions`)
- Executar commit só com pedido explícito do user: "commita isso",
  "faz o commit", "git commit -am '...'"
- Mesmo após série longa de edits relacionados, esperar pedido
- Não perguntar "posso commitar?" a cada edit — apenas sugerir
  mensagem e parar
- Em modo headless/CI: nunca commitar, mesmo com flag genérica de
  "auto"
