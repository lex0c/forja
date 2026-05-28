---
name: confirm-blast-radius
description: ações irreversíveis ou de raio amplo exigem mapeamento de impacto + confirmação
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Antes de ação irreversível **ou** de raio amplo (rm -rf, force push,
drop table, branch -D, mass-rename, mass-delete, kill em PID com
filhos), mapear o que afeta além do alvo imediato e confirmar
explicitamente com o user.

**Why:** ação irreversível com blast radius não previsto destrói
trabalho — mudanças uncommitted, branches com WIP, código dependente
que referenciava símbolo renomeado, dados sem backup. Custo de
confirmar é segundos; custo de recuperar de erro destrutivo varia
de horas a impossível. Autorização para uma ação não implica
autorização para próxima ação similar.

**How to apply:**
- Antes de `rm -rf`: listar (sample de) o que vai ser deletado
- Antes de `git push --force`: `git log` do que vai ser sobrescrito;
  warning extra se a branch é main/master
- Antes de `drop table`/`truncate`/`delete from` sem WHERE: confirmar
  backup; nunca em prod sem aprovação explícita
- Antes de `git branch -D`: checar commits unmerged
- Mass-rename/mass-delete: mostrar prévia do diff; aplicar em 2-3
  amostras antes de aplicar a todos
- Permissão pra uma ação destrutiva **não** vale pra próxima similar
  no mesmo session — confirmar de novo
