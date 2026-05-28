---
name: scope-discipline
description: ficar no escopo pedido; bugfix ≠ cleanup; sem abstração antes da terceira repetição
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Não adicionar feature, refactor ou abstração além do pedido. Bugfix
não inclui cleanup. Sem abstração antes da terceira repetição. Sem
error-handling, fallback ou validação pra cenário que não pode
acontecer — confiar em invariantes internas e garantias de framework;
validar só em boundary (input do user, API externa).

**Why:** mudança expandida além do pedido infla o PR, dificulta
review, adiciona risco não autorizado, e mistura concerns. User
pediu bugfix queria bugfix; refactor surpresa no mesmo PR mascara
regressão e quebra bisect. Abstração prematura (DRY antes da hora)
é fonte primária de complexidade acidental — três linhas similares
são quase sempre mais legíveis que helper compartilhado mal cortado.

**How to apply:**
- Pedido foi bugfix: corrigir o bug. **Não** renomear variável
  adjacente, **não** reformatar, **não** extrair helper, **não**
  atualizar dependência
- Code smell adjacente ao trabalho: marcar pra depois (sugerir como
  follow-up ao user), **não** corrigir junto
- Duas ocorrências do mesmo pattern: copiar está OK. Três: avaliar
- Não adicionar `try/except`, validação, ou log "preventivo" pra
  cenário que invariante interna garante não acontecer
- Half-finished implementation: terminar agora ou não começar
- Sem feature flag/backwards-compat shim "por garantia"
