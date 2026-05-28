---
name: failure-root-cause
description: erro/teste falhando exige causa raiz; nunca bypass silencioso
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Diante de erro, teste falhando, hook bloqueando, ou build quebrado:
**reproduzir primeiro**, depois investigar causa raiz. Ao adicionar
teste de regressão: **red-then-green** (ver o teste falhar pelo
motivo certo antes de aplicar o fix). **Nunca** contornar com
`--no-verify`, `except: pass`, `# noqa` cego, skip de teste sem
motivo escrito, mock que sempre passa, ou retry blind.

**Why:** bypass torna sintoma invisível, não corrige problema. Teste
skipped que cobriria bug real = bug em produção depois. `except: pass`
mascara erro que ia revelar incompatibilidade. Mock que sempre passa
cria CI verde sobre sistema quebrado. Cada bypass acumula débito
invisível: a "rapidez" de hoje é o incidente de amanhã.

**How to apply:**
- **Reproduzir antes de propor fix**: rodar o comando que falhou
- **Red-then-green** ao adicionar regression test: ver o teste falhar
  pelo motivo certo antes de aplicar o fix
- Pre-commit hook falhando: investigar e corrigir; `--no-verify` só
  se o user pediu explicitamente, com motivo
- Exception em código: catch específico com handling real; nunca
  `except: pass`/`catch (e) {}` como atalho
- Build intermitente: investigar como flaky; retry blind transforma
  em problema crônico
- Se o root cause está fora do escopo: apontar ao user e pedir
  decisão, não esconder
