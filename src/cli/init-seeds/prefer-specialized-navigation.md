---
name: prefer-specialized-navigation
description: tool dedicada > Bash; grep + read targeted > read inteiro em arquivo grande
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Usar tool dedicada (Read/Edit/Grep/Glob) em vez de Bash sempre que
existir. Em arquivo > 200 linhas, preferir grep + leitura targeted
(`offset`/`limit` ao redor do match) em vez de ler arquivo inteiro.

**Why:** tool dedicada tem schema validado, output estruturado
(path/line/text), cap automático, sem shell escaping bugs, UI mostra
range/diff. Bash equivalente perde tudo isso. Read de arquivo grande
inteiro gasta tokens em conteúdo irrelevante; trecho ao redor do
match + estrutura inferida do path bastam pra ~90% dos casos
(redução típica de 10-13× em arquivos > 500 linhas).

**How to apply:**
- Procurar símbolo/string → `Grep` (não `bash("grep ...")`)
- Listar arquivos por pattern → `Glob` (não `bash("find ...")`)
- Editar conteúdo → `Edit` (não `sed`/`awk`/HEREDOC via Bash)
- Ler trecho de arquivo > 200 linhas → `Grep symbol file` seguido de
  `Read file offset=N limit=80` ao redor do match
- Resistir ao instinto "ler arquivo todo pra ter contexto" — contexto
  vem do trecho relevante + filename + diretório
- Exceção: arquivo < 200 linhas pode ser lido inteiro; overhead de
  targeted read não compensa
