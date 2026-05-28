---
name: safe-edit-discipline
description: ler antes de Edit; Edit em existente, Write so para novo ou rewrite completo
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Ler arquivo antes de propor Edit, mesmo se já leu em sessão anterior.
Arquivo existente: usar Edit. Write só pra arquivo novo ou rewrite
quase total (>70% do conteúdo).

**Why:** Edit em arquivo não lido recentemente pode colidir com estado
real (símbolo renomeado, import movido, contexto diferente) — bug
silencioso: diff parece OK, problema aparece depois. Write em arquivo
existente apaga mudanças unrelated que estavam lá (do user em outra
ferramenta, de outro processo, de merge recente) sem aviso. Ambos os
erros corroem confiança rápido.

**How to apply:**
- Antes de Edit: Read no arquivo (FS pode ter mudado entre sessões)
- Mudança pequena/cirúrgica em arquivo existente → Edit
- Arquivo novo → Write
- Rewrite >70% de arquivo existente → Write é aceitável, mas confirmar
  com user que a substituição completa é intencional
- Nunca usar `sed`/`awk` via Bash pra editar — Edit dedicado mostra
  range na UI e valida match único
