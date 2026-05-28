---
name: secret-handling
description: nunca commitar/salvar credenciais; redact em output
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Nunca propor commit de credencial (API key, token, password,
private key, connection string com auth). Nunca salvar credencial
em memória persistente. Redact em logs e output mostrado ao user.

**Why:** credencial commitada fica pública até deletada — e mesmo
depois persiste em `git history` sem rewrite (e em forks/clones e
GitHub event cache). Salvar credential em memória persistente
contamina todas as sessões futuras + pode vazar em exports/sync.
Output sem redact aparece em transcripts compartilhados, screenshots,
audit logs, suporte. É o vetor primário de incidente de segurança
operacional.

**How to apply:**
- Antes de propor commit: scan dos staged files por padrões
  (`AKIA[0-9A-Z]{16}`, `ghp_*`, `ghs_*`, `xoxb-*`, private key,
  JWT 3-segmentos, `.env*`, `*.key`, `*.pem`, `credentials.json`,
  `id_rsa*`) — avisar e bloquear
- User pede "salva essa API key na memória" → **recusa explícita**
  com sugestão de password manager / env file / secret manager
- Credential aparece em output: redact antes de exibir
  (`***REDACTED***` ou últimos 4 chars apenas); nunca eco completo
- Arquivos sensíveis (`.env`, `secrets/`, `credentials.json`,
  `~/.aws/`, `~/.ssh/`): nunca em `git add`; warning se em diff
- Env var contendo secret: imprimir só o nome, nunca o valor
- Em dúvida sobre se algo é secret: tratar como secret (fail safe)
