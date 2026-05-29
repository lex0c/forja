# PERMISSION_ENGINE

Implementação **v2** da permission engine do `AGENTIC_CLI` — evolução do contrato v1 (`CONTRACTS.md` §9). Este doc é a especificação implementável: gramáticas formais, resolvers concretos, state machine, conformance suite, threat model da própria engine.

> **Premissa raiz:** o modelo é processo parcialmente confiável. A engine não autoriza *intenção* (LLMs não têm intenção estável entre turnos) — autoriza **ações isoladas dentro de capabilities pré-declaradas**, com decisão determinística e auditável.

---

## 0. O que muda da v1

| Aspecto | v1 | v2 |
|---|---|---|
| Modelo de regra | allowlist de comando string (`Bash(npm test)`) | **capability-based** + allowlist como camada superficial |
| Decisão | `allow` / `deny` / `confirm` | mesma + `score` (0–1) + `reason_chain` |
| Escopo temporal | session | session + **TTL explícito** + `once` + `pattern` |
| Audit | tabela `approvals` plana | append-only com **hash chain** + sealing externo opcional |
| Credenciais | implícito | **env scrubbing** declarativo por capability |
| Risco | binário | **score determinístico** + classifier opcional como hint (±0.2) |
| Sandbox | flag `bwrap` opcional | **integrado no pipeline**: profile selecionado pela engine |
| Subagent | herda regras (texto) | herda **e** restringe (subset-only formal) |
| Concorrência | indefinida | mutex por sessão + TOCTOU resolvido por snapshot |
| Reload de policy | indefinido | file-watch + validate-then-swap |
| Bootstrap de chain | indefinido | genesis derivado de `install_id` |
| Conformance | inexistente | suite YAML obrigatória, ≥100 casos pra GA |

V1 segue válido como **contrato externo** (Tool Registry ↔ Engine). V2 detalha o **interno**.

---

## 1. Princípios não-negociáveis

1. **Fail closed sempre.** Erro de carga, ambiguidade, classifier offline (em modo strict), sandbox indisponível, hash chain quebrada → deny / refuse.
2. **Determinismo antes de inferência.** Caminho determinístico decide. ML só ajusta score, jamais decide.
3. **Capability > comando.** Allowlist textual é frágil. Decisão final é em capabilities efetivas.
4. **Sem decisão silenciosa.** Cada decisão grava em `approvals_log` antes da execução.
5. **TTL obrigatório.** "Allow forever" não existe.
6. **Subagent é subset, nunca expansão.** Permissão é interseção, não união.
7. **Explicability first-class.** Toda decisão produz `reason_chain` legível.
8. **Reprodutibilidade auditável.** Toda decisão é replay-able dado: inputs + policy hash + classifier hash.

---

## 2. State machine da engine

A engine tem estados explícitos. Harness consulta `engine.state()` antes de qualquer tool call.

```
                    ┌──────────────────────────────────┐
                    │             init                  │
                    └────────────┬──────────────────────┘
                                 ↓ load_install_id()
                    ┌──────────────────────────────────┐
                    │       loading-policy              │
                    └────────────┬──────────────────────┘
                         valid ─┤├─ invalid
                                │└──────→ refusing (fatal)
                                ↓
                    ┌──────────────────────────────────┐
                    │       validating-chain            │
                    └────────────┬──────────────────────┘
                       intact ──┤├── broken
                                │└──────→ refusing (until --accept-broken-chain or --rotate-chain)
                                ↓
                    ┌──────────────────────────────────┐
                    │           ready                   │
                    └────────────┬──────────────────────┘
            classifier offline ──┤
            sandbox unavailable ─┤
            sealing target down ─┤
                                 ↓
                    ┌──────────────────────────────────┐
                    │          degraded                 │
                    └──────────────────────────────────┘
```

| Estado | Comportamento |
|---|---|
| `init` | rejeita toda chamada |
| `loading-policy` | rejeita toda chamada |
| `validating-chain` | rejeita toda chamada |
| `ready` | pipeline normal |
| `degraded` | pipeline com restrição: toda decisão `allow` automática vira `confirm` (ML offline, sandbox down, etc) |
| `refusing` | rejeita toda chamada com erro fatal; harness deve abortar sessão ou exigir override explícito do user |

Transição `ready ↔ degraded` é dinâmica (subsystem health). Transição pra `refusing` é **fatal e logada** — só sai com ação humana.

**Slice 141 M2 — transição inválida lança (throws-on-invalid):** o controller de estado em `src/permissions/state-machine.ts` codifica um `VALID_TRANSITIONS` map. Tentar transitar fora dele lança `Error` síncrono. Pre-amend, leitor da spec podia inferir "transição inválida = no-op idempotente"; código sempre throw. Lança é load-bearing pra catch de wiring bug:

- `loading-policy` → `loading-policy` lança (não há "re-load" implícito; reload de policy passa por `engine.reloadPolicy`, não por re-transição).
- `refusing` → qualquer outra coisa lança (refusing é terminal por design).
- `ready` → `init` / `validating-chain` lança (não há volta pelo state machine; restart do processo é o único caminho).
- `degraded` → `degraded` é tolerado como no-op (idempotência intencional pra hot paths onde N classifier failures sucessivas não deveriam emitir N transition events; pin em test).

Operadores que pegam o throw devem tratar como bug de boot/wiring, não como condição de runtime esperada. Sintoma típico: harness que tenta re-transitar pra `validating-chain` num resume — chamador wrong; resume não re-valida via state machine.

---

## 3. Modelo de recurso: capabilities

A engine não decide sobre "comandos". Decide sobre **capabilities** que o comando consumiria.

### 3.1 Capabilities canônicas

| Capability | Significado | Exemplos |
|---|---|---|
| `read-fs:<scope>` | Leitura | `read_file`, `grep`, `ls` |
| `write-fs:<scope>` | Escrita/criação/append | `write_file`, `edit`, `mv` |
| `delete-fs:<scope>` | Remoção | `rm`, `rmdir`, `git clean` |
| `exec:<class>` | Execução de processo (`shell`, `python`, `node`, `arbitrary`) | `bash` |
| `net-egress:<host>` | Saída de rede | `curl`, `web_fetch` |
| `net-ingress:<port>` | Listen local | servers |
| `secret-access:<store>` | Secret store (`aws`, `ssh`, `gpg`, `kube`, `env`) | tool específico |
| `git-write:<repo>` | Mutação git de estado (commit, push, branch -D) | `git_*` |
| `env-mutate` | Alterar `~/.bashrc`, `~/.config/*` | edits em paths protegidos |
| `agent-mutate` | Alterar `.agent/`, hooks, policy | autoexpansão |
| `host-passthrough` | Sair do sandbox (escape autorizado) | apenas com flag explícito |

### 3.2 Mapeamento tool → capabilities

Cada tool declara, em manifest, as capabilities **possíveis**. A engine deriva as **efetivas** dado os args via *capability resolver* (§5).

```toml
# tool_registry/edit.toml
name = "edit"
version = "1"
capabilities_declared = ["read-fs:*", "write-fs:*"]
resolver = "edit_resolver"  # nome do resolver registrado (§5)
```

Tool tentando consumir capability não declarada → engine recusa **antes** de invocar (`deny: undeclared_capability`). Bug de declaração não é bypass.

---

## 4. Scope grammar (formal)

Sem gramática formal, dois implementadores produzem decisões diferentes. Esta é a definição autoritativa.

### 4.1 BNF

```
scope        ::= capability ":" body
capability   ::= ident ( "[" attr "=" value "]" )?
ident        ::= [a-z] [a-z0-9-]*
body         ::= "*"                          ; wildcard absoluto
              | path-pattern
              | host-pattern
              | port-pattern
              | identity-pattern              ; pra secret-access, git-write
path-pattern ::= ("~" | "./" | "/") segment ("/" segment)*
segment      ::= "**" | "*" | literal
literal      ::= [a-zA-Z0-9_.+-]+
host-pattern ::= "*" | "*." host-literal | host-literal
host-literal ::= label ("." label)+
label        ::= [a-zA-Z0-9-]+
port-pattern ::= integer | integer "-" integer
identity-pattern ::= literal                  ; nome de store/repo
```

### 4.2 Semântica de match

| Token | Significado |
|---|---|
| `*` (em segment) | matches um único segment, sem `/` |
| `**` (em segment) | matches zero ou mais segments |
| `*` (em body) | wildcard absoluto — matches tudo da capability |
| `*.host.com` | matches subdomains diretos (`a.host.com`, **não** `a.b.host.com`) |
| `**.host.com` | (não suportado em v2; documentado) |

Glob é **case-sensitive em path** (Linux/macOS). Engine recusa policy carregada em FS case-insensitive sem flag explícito.

### 4.3 Path resolution (anti-symlink-escape)

Path em scope ou em arg do tool é resolvido **antes** do match:

1. **Tilde:** `~` → `$HOME` (frozen no SessionStart).
2. **Relativo:** `./x` → `<session.cwd>/x` (cwd frozen no SessionStart).
3. **Normalize:** `..`, `.` resolvidos textualmente.
4. **Realpath walk:** lstat por componente. Se qualquer componente é symlink:
   - resolve target,
   - se target sai da scope declarada → **deny com `reason=symlink_escape`** (não fallback silencioso).
5. **Mount check:** se path resolvido cruza mount point pra FS não-permitido (procfs, sysfs, devfs salvo whitelist) → deny.

Path em arg que falha qualquer passo → `deny(reason="path_resolution_failed", detail=...)`.

**`args.cwd` em bash family (slice 160).** O bash resolver atribui capabilities relativo a `ctx.cwd` (a session cwd frozen at SessionStart). O bash tool aceita também um `args.cwd` opcional pra mudar o working dir do spawn. Pré-slice 160 isso era um bypass: model emitia `bash {command:"cat foo", cwd:"/etc"}`, resolver atribuía `read-fs:<session>/foo`, broker honrava o absoluto, bash executava em `/etc/foo`. Engine nunca via `/etc/...` em nenhuma capability.

Slice 160 fix: `src/tools/builtin/_bash-cwd.ts` resolve + canonicaliza (realpath) ambos os lados e refuse se a forma canonical do `args.cwd` NÃO está em (ou abaixo de) o subtree canonical do `ctx.cwd`. `bash` e `bash_background` consomem o helper. Equal-to-session é OK; descendant é OK; ancestor/sibling/disjoint refuse com `tool.invalid_arg` e error message citando o canonical proposto.

Operator que precisa de cwd diferente: usa `cd <dir>` dentro do command (o resolver vê o command text e atribui caps pro cd target). Operators que precisam cross-project deveriam iniciar uma session separada com `--cwd <other>`.

Defese em camadas com slice 155 (canonicalization do sandbox runner): slice 155 protege a wrap layer pós-engine; slice 160 protege a tool-handler entry pré-engine. Os dois fecham diferentes pontos de symlink-escape no fluxo do bash.

**Cwd-scope symlink escape detection (slice 178 A1).** O canonical-aware classifier do slice 176 cobre symlinks que escapam pra zonas bem-conhecidas (`/etc`, `/proc`, `~/.ssh`...) e refuse/escalate na engine. Mas um symlink que aponta pra um path arbitrário **fora do cwd da sessão e fora dos protected paths** (`/work/proj/data/exfil → /tmp/exfil-target`) escapa de uma policy `allow read-fs:<cwd>/**` típica: o classifier de protected paths retorna null, o engine vê só `read-fs:/work/proj/data/exfil` (literal), matcha o glob e autoriza — o kernel segue o symlink em runtime e a leitura cai em `/tmp/exfil-target`. `detectCwdScopeEscape` em `src/permissions/resolvers/bash.ts` flagga lexical-inside-cwd-mas-canonical-fora-do-cwd e **degrada confidence para `low`** (força confirm) sem hard-refuse — yarn workspaces às vezes symlinkam pra siblings legítimos; hard-refuse quebraria. Confidence low funnela a call pelo modal do operador, que decide.

Canonicalização compartilhada entre `classifyArgWithCanonical` (protected paths) e `detectCwdScopeEscape` (cwd scope) via helper `canonicalizeForClassification` com três fallbacks sequenciais:

1. **`realpath(lexicalAbs)`** — fast path; sucesso quando todo componente existe.
2. **`readlink(lexicalAbs)`** — quando (1) lança ENOENT mas o leaf é symlink (target removido OU nunca existiu). `readlink` retorna o target literal sem resolução recursiva. Target absoluto = usa direto; target relativo = resolve contra `dirname(lexicalAbs)`. Sem essa probe, um dangling symlink `<cwd>/outlink → /tmp/x` colapsa pro lexical e o detector retorna "no escape" — mas o kernel segue o symlink em runtime (`> outlink` cria `/tmp/x`).
3. **`realpath(dirname) + basename`** — fresh file sob parent existente; cobre parent-é-symlink (`<cwd>/alias/leaf` onde `alias → /etc`).

Production wiring em `src/permissions/engine.ts` passa `fs.realpathSync` + `fs.readlinkSync`. Tests podem omitir o seam de `readlink` (comportamento idêntico ao pre-fix — defesa aditiva, sem regressão).

### 4.4 Compilação e validação

Policy carrega → compila glob → falha de compilação = policy inválida = engine vai pra `refusing`. Erros comuns:
- glob com regex acidental (`(`, `)`, `[a-z]`)
- segment vazio (`//`)
- tilde em meio de path (`/foo/~/bar`)
- mistura de path-pattern e host-pattern na mesma capability

---

## 5. Capability resolvers (per-tool)

Esta é a parte que estava hand-waved. Aqui está formal.

### 5.1 Interface

Resolver é função **pura, determinística, terminante em < 5ms**:

```
resolve(args, ctx) → ResolverResult
  args : Map[string, JsonValue]                  # tool args validados pelo schema
  ctx  : { cwd: AbsPath, home: AbsPath, env_keys: [string] }
  
ResolverResult :=
  | Ok { capabilities: [Capability], confidence: high|medium|low }
  | Conservative { capabilities: [Capability], reason: string }   # capability set conservador
  | Refuse { reason: string }                                      # resolver não consegue decidir; deny
```

Confidence força aprovação humana conforme tabela §6.6:
- `confidence = low` → upgrade allow→confirm (sempre).
- `confidence = medium` → **NÃO** força upgrade automático (slice 139 D1).
- `confidence = high` → silent allow.

Decisão de calibração: medium foi originalmente listado como triggering upgrade (linha histórica deste documento), mas operadores observaram fadiga excessiva com workloads multi-step onde resolvers caem em medium por motivos benignos (cwd-relativo não-canônico, expansão de path simples). A regra atual é "só `low` força confirm"; calibração via outcome_signals (§6.3.2) pode tunar o threshold de score em vez de gate por confidence — score já compõe confidence-low (+0.30) e classifier-hint num único float [0,1] que cruza `scoreConfirmThreshold` (default 0.40). Engine reference: `src/permissions/engine.ts:1020-1030` (`scoreForcesConfirm`).

### 5.2 Resolvers builtin (exemplos)

#### `read_file`

```
resolve({file_path}, ctx) =
  let p = resolve_path(file_path, ctx)
  Ok { capabilities: [ read-fs(p) ], confidence: high }
```

#### `write_file` / `edit`

```
resolve({file_path, ...}, ctx) =
  let p = resolve_path(file_path, ctx)
  Ok { capabilities: [ write-fs(p), read-fs(p) ], confidence: high }
```

#### `bash` (a parte difícil)

Resolver bash usa **AST parsing** (lib `tree-sitter-bash`), não regex. Pipeline:

```
1. parse(command_string) → AST
2. extract_commands(ast) → list of (cmd, args, redirections, env_vars)
3. para cada (cmd, args):
     a. lookup em command_resolver_registry[cmd]
     b. se hit → resolve_specific(cmd, args, ctx)
     c. se miss → conservative()
4. agregar capabilities; confidence = min(confidences)
5. detectar dynamic eval:
     - $(...) com conteúdo não-literal → confidence = low
     - eval, source com arg variável → Refuse
     - backtick com conteúdo não-literal → confidence = low
6. retornar
```

`command_resolver_registry` (extensível):

| cmd | resolver |
|---|---|
| `rm` | `delete-fs(args após flags)`; `-rf` → confidence=high; `-rf /` ou `~` direto → bloqueado em §11 |
| `mv`, `cp` | `read-fs(src) + write-fs(dst)` |
| `curl`, `wget` | `net-egress(extract_host(args))`; pipe pra shell (`\| sh`, `\| bash`, `\| zsh`, `\| python -c`, etc.) → **Refuse** com reason `pipe-to-shell` (slice 139 D2, antes era `confidence=low + flag`). Justificativa: a tabela adversarial mais abaixo nesta mesma §5.2 já lista `$(curl ... \| sh)` como Refuse; pipe-direct-to-shell tem o mesmo threat shape (output controlado pelo remoto vai pra interpretador) e calibração empírica mostrou zero falsos positivos legítimos. Engine reference: `src/permissions/resolvers/bash.ts:2218-2222`. |
| `git` | switch por subcomando: `commit`/`push` → `git-write(repo)`; `clean -f` → `delete-fs(repo) + git-write(repo)` |
| `npm`, `yarn`, `bun`, `pip` | `exec:arbitrary + write-fs(node_modules \| venv) + net-egress(registry hosts)` |
| `cat`, `ls`, `head`, `tail`, `wc`, `grep`, `find` (sem `-exec`) | `read-fs(args)` |
| `sort`, `uniq`, `cut`, `comm`, `paste`, `tr`, `nl`, `tac`, `rev`, `fold`, `column`, `diff`, `cmp`, `jq`, `du`, `df`, `tree`, `basename`, `dirname` | filtros read-only: `read-fs(args)` (texto/metadata puro; sem exec, sem write). Mesma classe de `cat`/`wc` — registrados no `command_resolver_registry` pra não caírem no fallback Conservative à toa. Excluídos deliberadamente: `sed` (`-i`/`w` escrevem), `awk` (`system()`/redirect), `xargs` (exec), pagers `less`/`more` (`!cmd` shell-out) — esses seguem como comando desconhecido → Conservative |
| `find` com `-exec` | `exec:arbitrary` + capabilities do comando exec |
| `chmod`, `chown` | `write-fs(target)` + flag `permission-mutate` (escala score) |
| `dd`, `mkfs.*`, `fdisk`, `parted`, `mkswap`, `shred` | sempre `Refuse` em v2 (não há resolver seguro) |
| `sudo`, `doas`, `pkexec`, `su` | sempre `Refuse` (slice 180 — privilege boundary; operator usa `--sandbox-host` + policy explícita pra elevações legítimas) |
| `chroot`, `unshare`, `nsenter`, `setpriv` | sempre `Refuse` (slice 180 — namespace/privilege manipulation) |
| `useradd`/`userdel`/`usermod`/`groupadd`/`groupdel`/`groupmod`/`passwd`/`chpasswd`/`visudo` | sempre `Refuse` (slice 180 — user db mutation) |
| `reboot`/`shutdown`/`halt`/`poweroff`/`kexec`/`init`/`telinit` | sempre `Refuse` (slice 180 — system halt + runlevel) |
| `crontab`/`at`/`batch`/`systemd-run` | sempre `Refuse` (slice 180 — scheduled persistence fires outside audit chain) |
| `insmod`/`rmmod`/`modprobe`/`depmod` | sempre `Refuse` (slice 180 — kernel-module injection) |
| `wipefs`/`debugfs`/`tune2fs`/`xfs_admin`/`hdparm`/`badblocks` | sempre `Refuse` (slice 180 — destructive filesystem ops not covered by `dd`/`mkfs.*`) |

Conservative fallback (cmd desconhecido):

```
Conservative {
  capabilities: [
    exec:shell,
    read-fs(<cwd>/**),
    write-fs(<cwd>/**),
    net-egress(*)             # se policy permite egress
  ],
  reason: "unknown_command:" + cmd
}
```

Conservative força `confirm` (score component +0.15 por unknown_command). User pode aprovar uma vez ou registrar resolver custom.

#### Detecções adversariais (sempre `confidence: low` ou `Refuse`)

| Padrão | Resposta |
|---|---|
| `eval $X` com $X não-literal | Refuse |
| `bash -c "$VAR"` com $VAR não-literal | Refuse |
| `$(curl ... \| sh)` | Refuse |
| `< /dev/tcp/` reverse shell idiom | Refuse |
| `python -c "exec(...)"` com arg dinâmico | Refuse |
| Heredoc com conteúdo não-literal | low confidence |
| Process substitution `<(...)` com cmd dinâmico | low confidence |
| Variable indirect (`${!var}`) | Refuse |

#### Resolver-level pre-policy refuses (slice 141 M3)

O contrato §5.1 do resolver é "emit capabilities OR Refuse". Por design, o resolver corre ANTES do estágio de static rules — Refuse no resolver curto-circuita o pipeline e ignora qualquer `allow` que o operador tenha colocado em `permissions.yaml`. Isso é proposital pra certos shapes onde nenhuma operator-policy razoável deveria autorizar:

- **SSRF blocklist (slice 129 R5 P0)** em `fetch_url`: loopback, RFC1918, link-local (incluindo AWS/GCP metadata at 169.254.169.254), CGNAT, multicast, IPv6 loopback / link-local / unique-local, IPv4-mapped/-compatible IPv6 (slice 140 sec-4). Operator não pode `allow: 169.254.169.254` mesmo querendo — o resolver Refuse antes da policy entrar. Spec dependency: `SECURITY_GUIDELINE.md §9.1.6`.
- **Bash hard-refuse commands**: `eval`, `exec`, `source`, `command`, `builtin`, `env <prog>` (slice 139 C1), `dd`, `fdisk`, etc. (lista canônica em `bash.ts:HARD_REFUSE_COMMANDS`). Operator não pode autorizar via `allow: "env *"` — o resolver Refuse antes.
- **Bash hard AST shapes (`HARD_REFUSE_NODES`)**: command substitution `$(...)`, process substitution `<(...)`/`>(...)`, function definitions, prefixo `VAR=val cmd` (override de binary resolution), arithmetic expansion `$((...))`, heredoc/herestring com corpo, indirect `${!var}`, command_name dinâmico. Shapes que habilitam exec arbitrário ou injeção que o resolver não consegue modelar → Refuse pre-policy. (Lista canônica em `bash.ts:HARD_REFUSE_NODES`.)

A semântica: resolver Refuse é uma **trava engine-level** que **operator policy não pode destravar**. A motivação é o threat model — esses shapes representam classes de comportamento que mesmo um operador "trusted" não deveria poder autorizar via policy YAML (separação operator vs platform). Diferente de `[[deny]]` em policy, que é override-able via layer mais alto: resolver Refuse é piso, policy é teto.

Pre-amend, §5 falava genericamente de "Refuse" mas não documentava que Refuse vem ANTES das static rules. Slice 141 M3 amenda explicitamente.

#### Soft-unmodeled → Conservative (não Refuse)

Nem todo shape não-modelável é perigoso, e jogar todos no `Refuse` (deny duro, pre-policy, sem confirm) contradiz §5.2 step 3c ("miss → `conservative()`") e TREE_SITTER_SHELL §9.3 ("o resto vira confirm humano — exatamente onde deveria"). Uma fase do resolver lumpava control flow e comando-fora-do-registry no mesmo `Refuse` que `eval`/`$(...)`, o que matava até `for f in *.ts; do cat "$f"; done` e `sort foo` — o modelo não conseguia rodar script básico nem read no path do próprio repo.

Disposição correta — estes shapes → **Conservative** (força `confirm`; operator decide), NÃO Refuse:

- **Control flow / agrupamento**: `if`/`while`/`for`/`case`, subshell `( )`, grupo `{ ; }`, negação `! cmd`, condicional `[[ ]]`/`[ ]`.
- **Expansão de valor**: `$var`, `${var:-x}`, arg com conteúdo runtime não-literal (command name continua tendo que ser literal — dinâmico → hard Refuse).
- **Comando fora do `command_resolver_registry`** (table-miss), conforme o fallback Conservative já especificado acima.

Salvaguarda (a parte load-bearing): antes de degradar pra Conservative, o resolver faz um scan de blocklist do **AST inteiro** (`scanForHardConstructs`) — se houver QUALQUER `HARD_REFUSE_NODES`, comando em `HARD_REFUSE_COMMANDS`, ou pipe-to-shell em qualquer ponto (inclusive dentro do corpo do loop/condicional), o resultado volta a ser Refuse. Assim `for x in *; do eval "$x"; done` continua deny (o `eval` no corpo é pego pelo scan), mas `for f in *.ts; do cat "$f"; done` vira confirm. A trava pre-policy de §5.2 (Refuse não-destravável) permanece intacta pro conjunto hard; só o conjunto soft-benigno migra pra Conservative.

Headless / não-interativo: Conservative sem operador resolve como qualquer `confirm` não-respondível → deny. A postura de segurança não afrouxa; o que muda é parar de matar comando benigno quando existe humano (ou policy `allow`) pra aprovar.

### 5.3 Resolvers de MCP tools

MCP tool declara seu resolver no manifest (JS function ou TOML pattern). Resolver MCP roda **em isolamento** (worker separado, sem acesso a engine state). Output validado contra schema antes de aceitar.

MCP tool sem resolver declarado → resolver default conservador: capability set = capabilities declaradas no manifest (sem refinamento). Sempre força `confirm`.

### 5.4 Resolver registry e versionamento

Cada resolver tem `version` no manifest. Mudança de versão = bump explícito + entrada em changelog. Audit log grava `resolver_version` na decisão pra replay.

---

## 6. Pipeline de decisão (6 estágios)

```
[1] Resolve         — args → capabilities concretas (§5)
[2] Static rules    — match deterministic deny/allow/ask (§6.2)
[3] Risk score      — score determinístico (§6.3)
[4] Classifier      — opcional; ajusta score em ±0.2 (§6.4)
[5] Sandbox plan    — escolhe profile; valida viabilidade (§6.5)
[6] Approval gate   — auto-allow / human-confirm / deny final (§6.6)
```

Falha em qualquer estágio → `deny`.

### 6.0 Reason chain taxonomy (slice 141 M5)

Cada decisão emite um `reason_chain: ReasonChainEntry[]` no audit row, onde cada entry tem `{ stage, layer?, rule?, section?, note? }`. O `stage` taxonomy canônica é:

| Stage | Quando emite | Source de `source.layer` | Notas |
|---|---|---|---|
| `resolve` | Estágio 1 produziu capabilities Ok | resolver | Reason livre. Não emitido pra Refuse — esse usa `resolver-refuse`. |
| `resolver-refuse` | Resolver retornou Refuse pré-policy | resolver | Curto-circuita pipeline (§5.2 M3). |
| `static-rule` | Match em policy (`deny`/`allow`/`ask`) | enterprise / user / project / session | `rule` + `section` populados. |
| `default-deny` | Nenhuma rule deu match, strict mode | engine | Fail-closed default. |
| `engine-default` | Misc-category tool sem rule, bypass mode | engine | Auto-allow path. |
| `risk-score` | Estágio 3 produziu score > 0 | engine | `note` carrega `score=0.NN`. |
| `classifier` | Estágio 4 ajustou score | engine | `note` carrega `adjust=X.XX (<reason>)`. |
| `classifier-unavailable` | Estágio 4 falhou (null / throw / invalid output) | engine | `note` carrega a causa. |
| `sandbox-plan` | Estágio 5 escolheu profile | engine | `note` carrega `profile=<name>`. Emitido sempre que sandbox foi configurado. |
| `sandbox-refused` | Estágio 5 retornou no_viable_sandbox | engine | `note` carrega `uncovered=[...]`. |
| `approval-gate` | Estágio 6 forçou confirm (score ≥ threshold ou confidence=low) | engine | Diferenciador entre auto-allow e human-confirm. |
| `engine-state` | State != ready interceptou a decisão | engine | `note` carrega `state=<degraded\|refusing\|...>`. |
| `subagent-effective` | Capability fora do envelope do subagent (§10.1) | engine | `note` carrega capability `uncovered`. |
| `grant-match` | Session-grant matched (§8) | session (sempre) | `rule` carrega o grant id (ULID). |
| `protected-path` | Caller tocou protected path (§11) | engine | Override path: lista de paths escalada por classifier. |
| `session-allow` | `addSessionAllow` runtime "yes, don't ask again" | session | `rule` é o pattern memorizado. |

**Source attribution semantics:** `source.layer` indica qual policy layer escreveu a regra que firou (`enterprise`/`user`/`project`/`session`/`default`/`engine`); `source.rule` é o pattern string ou ULID do grant; `source.section` é a chave de §3.2 (ex: `bash`, `fs.read`, `fetch_url`, `grants`).

**Audit consumer contract:** stages são strings estáveis. Adição de novos stages = bump de versão da engine (§16). Operadores escrevendo grep/jq queries contra `reason_chain` devem ler esta tabela como a lista canônica.

Pre-amend, §6 listava apenas o pipeline em 6 fases sem documentar os stage names que o audit row carrega. Operadores liam fontes de `engine.ts` pra descobrir nomes. Slice 141 M5 canonicaliza.

### 6.1 Resolve

Já especificado em §5.

### 6.2 Static rules

**Engine-floor refuses (operator-policy não-overridable).** Antes da hierarquia operator-driven, dois conjuntos de patterns hardcoded fixam o piso de segurança:

1. **Bash hard-refuse commands** (já documentado acima §5.2): `eval`, `exec`, `source`, `dd`, `fdisk`, etc. Operator `allow: "*"` não autoriza.
2. **SEC §8.4 sensitive paths** (slice 159 wire): `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/**`, `.aws/credentials`, `**/credentials*.json`, `**/secrets.yml`, etc. Lista canônica em `src/permissions/sensitive-paths.ts:SENSITIVE_PATH_DENY_LIST`, mirror direto de `SECURITY_GUIDELINE.md §8.4`. Wired em `engine.ts:checkPath` (fs-tools: `read_file`, `write_file`, `edit_file`, `grep`, `glob`) e na branch bypass-mode do bash capability loop (`engine.ts:1660+`). Engine-floor refuse fire ANTES de `deny_paths`/`session_allow`/`allow_paths`/`confirm_paths` — operator policy não pode widen access.

Patterns são name-shape (não path-prefix), com normalização `**/<pattern>` pra qualquer profundidade. Por design, dois caminhos diferentes pra um `.env`:

- `read_file('.env')` (operador no cwd raiz) — refuse.
- `read_file('deep/nested/path/.env')` (em subdir) — refuse.

Ambos retornam decision `{ kind: 'deny', source: { layer: 'default', section: 'protected' } }` com `reason` citando o pattern que casou. Source.layer='default' deixa explícito ao operador que NENHUM YAML autorizou — é piso engine.

Coverage do wire na phase 1 de slice 159:

- ✅ `read_file` / `write_file` / `edit_file` em `strict`/`permissive` (via `checkPath`).
- ✅ `grep` / `glob` em `strict`/`permissive` (via `checkPath`, mesma seção fs.read/fs.write).
- ✅ **Todos os tools em `mode=bypass`** (via capability loop compartilhado em `engine.ts:1660+`). O branch `if (mode === 'bypass')` roda ao nível de dispatch ANTES do switch por categoria, iterando `read-fs`/`write-fs`/`delete-fs` caps. Cobre `bash {command:"cat .env"}` (resolver emite read-fs) E `read_file({path:".env"})` (fs.read resolver idem). Bypass NÃO override §8.4.
- ⚠️ `bash` em `strict`/`permissive`: command-string evaluation only — `cat .env` é avaliado contra `bash.allow/deny` patterns, NÃO contra §8.4. Operator que quer defesa simétrica adiciona `bash.deny: ['cat *\\.env*', 'cat *.pem', ...]` no YAML. Spec §8.4 obriga §8.4-patterns SÓ em fs-tools por design (o nome do tool é o gate; bash é uma superfície separada com sua própria policy surface).

**Hierarquia operator-driven (continua):** `enterprise → user → project → session`. Em cada nível, ordem `deny → ask → allow`. Match no nível mais alto vence; primeiro match dentro do nível vence.

```toml
[[deny]]
capability = "write-fs"
scope = ".git/**"
reason = "git internals are protected; use git_* tools"

[[deny]]
capability = "exec"
scope = "*"
match.command_substring = ["curl | bash", "wget | sh"]
reason = "pipe-to-shell is never auto-approved"

[[ask]]
capability = "net-egress"
scope = "*"
ttl = "session"

[[allow]]
capability = "read-fs"
scope = "**"
ttl = "session"
```

**Empate de match → deny vence.** Ambiguidade dentro do mesmo nível (dois `allow` casam) → o primeiro listado vence (deterministic order).

#### 6.2.1 Concorrência

Decisões dentro de uma sessão são **serializadas por mutex de sessão**. Tool calls paralelos esperam.

Cross-session:
- `grants` table: linha por (scope, capability) com row-level lock; UPDATE com `WHERE expires_at > now()` é atômico.
- `approvals_log`: append-only com sequence number monotônico.
- Policy hot reload (§12): swap atômico de struct compilada; decisão em curso usa snapshot da policy carregado em estágio [1].

#### 6.2.2 TOCTOU

Cada decisão captura snapshot de:
- timestamp (`decision_ts`)
- policy hash (`policy_hash`)
- grants ativos (snapshot list)
- classifier hash (se usado)

Estágios subsequentes consultam **snapshot**, não estado live. Se TTL expira durante decisão, decisão emitida é válida (foi computada com estado válido); a próxima decisão usará estado atualizado.

### 6.3 Risk score (determinístico)

Score 0.0–1.0. Soma de features com pesos calibrados.

#### 6.3.1 Features e pesos (v2 baseline)

| Feature | Peso | Notas |
|---|---|---|
| capability ∈ {`delete-fs`, `git-write`, `env-mutate`, `agent-mutate`} | +0.40 | crítico |
| scope == `*` | +0.20 | wildcard absoluto |
| scope inclui `~` ou root absoluto fora de cwd | +0.15 | escape de workspace |
| comando contém substring de blocklist (`rm -rf`, `chmod -R`, `dd`, `mkfs`) | +0.30 | padrões letais |
| net-egress fora de allow-list confiável | +0.25 | exfil potencial |
| ≥3 tool errors consecutivos antes desta call | +0.15 | sinal de modelo perdido |
| arg contém shell expansion complexa (`$(`, backtick, `;`, `&&` em bash) | +0.20 | composição |
| tool é MCP (não builtin) | +0.10 | superfície de supply chain |
| confidence do resolver = `medium` | +0.10 | |
| confidence do resolver = `low` | +0.30 | |
| ação acontece em `degraded` state | +0.20 | sistema em fallback |

Cap em 1.0. Componentes registrados em `score_components` no audit log (replay e calibração).

#### 6.3.2 Calibração

Pesos do baseline são **chute informado**. Plano de calibração:

1. Coletar telemetria por 30d em deployment piloto: `(score, decision_humano, outcome)` triples.
2. Logistic regression com `outcome ∈ {harmful, harmless}` como label, features como input.
3. Re-derivar pesos.
4. A/B test pesos derivados vs baseline; medir taxa de approval-fatigue (proxy: % `allow` clickado em < 1s).
5. Atualização de pesos = bump de versão da engine; audit log grava versão.

Sem calibração: baseline é defensável mas não otimal. Documentado como `calibration: baseline-v2.0`.

##### 6.3.2.1 outcome-baseline-v2.0 (slice 131)

A spec §6.3.2 plano define INPUT (triples) e MÉTODO (logistic regression) mas deixa em aberto **como** o sistema deriva `outcome ∈ {harmful, harmless}` a partir dos sinais observáveis. Slice 131 materializa a derivação em `outcome_signals` (AUDIT.md §1) + `computeOutcomeForApproval` (aggregator) com o seguinte baseline congelado pra reprodutibilidade:

**Proxies de outcome** (signal kinds, cada um liga via `approval_seq` ao row de `approvals_log`):

| `signal_kind` | Weight default | Wire site | Rationale |
|---|---:|---|---|
| `tool_error` | 0.30 | harness/loop: tool authorized → executed → returned error | Fraco — tool errors são frequentemente benignos (retry, missing file, transient network). Single error rarely implies a decisão estava errada. |
| `failure_event` | 0.50 | failures/sink dual-write quando `payload.approval_seq` matches session | Médio — failure_event downstream (sandbox loss, storage contention) correlaciona com a decision mas não prova causalidade. |
| `checkpoint_reverted` | 0.90 | cli/checkpoints `--undo` / restore | Forte — operator `--undo` é o sinal mais valioso: julgamento humano explícito de que a mudança não deveria ter acontecido. |
| `session_aborted` | 0.20 | harness/loop `finish()` quando exit ∈ {interrupted, error}, last 5 approvals | Fraco — sessions abort por muitos motivos (Ctrl+C, timeout, cost cap, crash); maioria não implica decision errada. Incluído pra completude do set de proxies; calibração pode zerar. |

**Composite policy:** `max-wins`. `composite = max(signal_weight ∀ signal ∈ approval)`. O sinal mais damning ancora o composite — `checkpoint_reverted` (0.9) domina um `tool_error` (0.3) coexistente, porque o operator `--undo` carrega evidence forte enquanto o tool error pode ser ruído. Somar diluiria; mediar diluiria. Max-wins prioriza evidence-quality.

**Binary mapping:** `composite >= COMPOSITE_HARMFUL_THRESHOLD` → `harmful`, else `harmless`. `COMPOSITE_HARMFUL_THRESHOLD = 0.5`. Defensável (matches o score's `scoreConfirmThreshold` default) mas não ótimo — o threshold em si é parâmetro de calibração na §6.3.2 step 3.

**Reproducibility:** baseline-v2.0 pesos + threshold são `const`s exportadas em `src/outcomes/codes.ts` (`DEFAULT_SIGNAL_WEIGHTS`, `COMPOSITE_HARMFUL_THRESHOLD`, `DEFAULT_SIGNAL_TTL_DAYS`). Audit log de calibração registra qual versão dos pesos foi usada em cada sweep — `outcome-baseline-v2.0` é o piso fixo até v2.1 ser derivada via §6.3.2 plan.

**Per-kind retention:** `outcome_signals.ttl_expires_at` é per-row, não table-wide. `checkpoint_reverted` retém **730d** (padrão §1.2 é 365d) — sinal forte vale janela maior pra regressões anuais. Demais kinds = 365d. Ver AUDIT.md §1.2.1.

**Limitations declaradas:**

- Triples disponíveis hoje cobrem só `approvals_log.decision ∈ {confirm-allowed, confirm-denied}` com labels limpos. Auto-allow/auto-deny representam a maioria das decisions mas têm zero outcome signal direto — calibration vai sofrer selection bias até `agent gc` + `outcome_signals` ttl-floor permitirem inverse-propensity-weighting.
- Sinais `tool_error` e `session_aborted` carregam ambiguidade não-causal alta (tool error por bug do código vs decision errada). Calibration sweep deve esperar `checkpoint_reverted` ser o sinal dominante; outros são complemento.
- `confirm-allowed` seguido de `--undo` dentro do mesmo session é o caminho mais forte pra `outcome=harmful` com baixa false-positive rate.

##### 6.3.2.2 Operator surface: `agent permission calibration-export` (slice 138)

Materializa o §6.3.2 step 1 (coletar triples por 30d) como verb CLI DB-only — sem provider, sem sessão. Reads `approvals_log` + `outcome_signals` da install corrente.

**CLI shape:**

```
agent permission calibration-export [--json] [--since-days N] [--all-decisions] [--limit N]
```

**Flags:**

| Flag | Default | Semantics |
|---|---|---|
| `--json` | text mode | NDJSON-per-triple em stdout; coverage summary em stderr (pipes consomem stdout limpo) |
| `--since-days N` | 30 | janela `[now - N*86400_000, now)` em `approvals_log.ts`. Inteiro positivo |
| `--all-decisions` | off | widens decision filter para `'*'` (todas as decisões). Default mantém `['confirm-allowed','confirm-denied']` per §6.3.2.1 limitations |
| `--limit N` | 100_000 | cap defensivo no result set; calibration sweeps típicos cabem |

**Default text output (stdout):**

```
calibration export — install_id=<uuid>
window: last 30 days
triples: <N>
  harmful : <H>
  harmless: <M>
  with at least one outcome_signal: <S>
by decision:
  confirm-allowed: <count>
  confirm-denied: <count>

note: <100 triples in window — calibration sweep recommended at ≥100+ rows.   ← opcional, fires quando total < 100
```

**`--json` NDJSON envelope (stdout):**

Uma linha JSON por triple, achatada (sem o `OutcomeAggregate` aninhado):

```json
{
  "approval_seq": <int>,
  "ts": <ms>,
  "tool_name": "<string>",
  "decision": "<confirm-allowed|confirm-denied|...>",
  "score": <float [0,1]>,
  "score_components": { "<feature>": <float>, ... },
  "outcome": "harmful" | "harmless",
  "composite": <float [0,1]>,
  "signal_kinds": ["checkpoint_reverted", ...]
}
```

Coverage summary (mesmo texto do default mode) sai em stderr no `--json` mode — operator scripts que filtram stdout com `jq` veem só os triples; o sumário fica visível interativamente sem poluir o pipe.

**Exit codes:** 0 (success — inclusive zero triples no window), 1 (install_id failure / DB error / --since-days invalid).

**Install scope:** sempre filtrado pela install_id resolvida via `ensureInstallId`. Calibration cross-install num DB compartilhado é forbidden por construção — `extractCalibrationTriples` requer `installId` no contract, sem default.

**Score components malformed:** se `approvals_log.score_components_json` está corrompido (storage rot, edição hostil), a linha não aborta o sweep — degrada a `{}` com stderr warn. O `score` row-level continua válido (coluna separada).

**Out of scope (futuros slices):**
- Step 2 (logistic regression) — offline tooling do operator (Python/R/etc.) consumindo o NDJSON. Não há regression in-process.
- Step 3 (re-derive weights) → bump dos `DEFAULT_SIGNAL_WEIGHTS` em `src/outcomes/codes.ts` + nova baseline string (`outcome-baseline-v2.1`).
- Step 4 (A/B test) precisa harness de side-by-side scoring.
- Step 5 (engine version bump) amarra ao audit log marker.

### 6.4 Classifier (opcional, hint-only)

Se habilitado e disponível, recebe:
- nome da tool
- capabilities resolvidas (não args brutos)
- score determinístico
- contexto resumido (últimos N steps, sumarizados pela engine)
- classifier_hash (versão do modelo)

**NÃO recebe:** tool outputs, conteúdo de arquivos lidos, web fetches, args brutos com conteúdo controlável por adversário. Defesa contra prompt injection no classifier.

Output:
```json
{
  "score_adjust": -0.15,
  "score_adjust_clamped_to": [-0.2, 0.2],
  "reason": "command pattern matches benign build script"
}
```

Falhas:
- offline / timeout > 500ms / schema inválido / clamping aplicado → `classifier_unavailable` em reason_chain
- engine em modo strict (`classifier.required = true`) → state vai pra `degraded`, score determinístico prevalece
- engine em modo lenient (default) → simplesmente ignora classifier nessa decisão

### 6.5 Sandbox plan

Profiles disponíveis (Linux via `bwrap`; macOS via `sandbox-exec` com sbpl equivalente; Windows não suportado em v2):

| Profile | FS | Net | Process | Hide |
|---|---|---|---|---|
| `ro` | tudo readonly | unshare-net | unshare-pid | secret paths (§7) |
| `cwd-rw` | cwd writable, resto ro | unshare-net | unshare-pid | secret paths |
| `cwd-rw-net` | cwd writable | egress filtrada por allowlist (nftables ou via proxy) | unshare-pid | secret paths |
| `home-rw` | $HOME writable, resto ro | unshare-net | unshare-pid | secret paths exceto se capability autorizou |
| `host` | passthrough | passthrough | passthrough | nada |

Algoritmo de seleção:

```
candidates = [profile for profile in profiles
              if all(cap in profile.allowed_capabilities for cap in resolved_caps)]

if not candidates:
  return deny("no_viable_sandbox")

if `host` ∈ candidates and other ∈ candidates:
  candidates.remove(`host`)         # host é sempre último recurso

# tie-break: ordem fixa (mais restritivo primeiro)
order = [ro, cwd-rw, cwd-rw-net, home-rw, host]
return first profile in order from candidates
```

`host` exige flag explícito do user **e** capability `host-passthrough` allowed em policy. Sem ambos → deny mesmo se outras condições baterem.

Sandbox indisponível (kernel sem unshare, bwrap binary missing) → state = `degraded`. Em `degraded`, profile mais alto disponível é `host` com confirm forçado em **toda** call. Se sandbox é `required: true` em policy → state = `refusing`.

**cwd canonicalization (slice 155).** Antes do hide_paths check, do `--bind` / `--chdir` (Linux) ou da geração do SBPL profile (macOS), o runner `realpath()` o `cwd` recebido. Defesa contra symlink-to-hidden-dir:

- **Threat shape:** operator (ou attacker com write access a um dir não-sensível) planta `/tmp/work → ~/.ssh/audit/`. Pré-slice o guard literal-string `cwd.startsWith('/home/op/.ssh')` não casava com "/tmp/work" e let it through. bwrap's `--bind` segue symlinks at source, montando cwd ON TOP OF o real `.ssh/audit/`. SBPL no macOS gera allow-rule sobre o literal cwd path enquanto deny rules apontam para o canonical hidden path — last-match favor allow.
- **Fix:** `realpath(cwd)` resolve a symlink chain. O canonical path passa por todos os downstream consumers (check + bind + chdir + SBPL profile).
- **Failure modes** (todos → refuse com diagnostic):
  - `ENOENT` → "cwd does not exist (broken symlink target?)"
  - `ELOOP` → "cwd symlink chain loops"
  - `EACCES`/`EPERM` → "cwd cannot be canonicalized: permission denied"
  - `ENOTDIR` → "cwd or ancestor is not a directory"
  - Outros → refuse defensivo com code + message
- **Escopo:** apenas o cwd raiz. Symlinks INSIDE cwd (e.g. `cwd/cache → ~/.aws/sso/cache`) NÃO são canonicalizados — known limitation. Mitigações:
  - Operator preserva cwd canonical antes de iniciar (`cd "$(realpath .)"`).
  - Engine-side §4.3 `symlink_escape` deny ainda fire em resolver-detected symlink targets.
  - Recursive realpath sweep at every spawn é cost-prohibitive; bwrap não expõe no-follow flag pra essa semântica.

**Trust model do sandbox binary (slice 154).** A resolução do binary do sandbox segue uma ordem canonical-first:

1. **Canonical literal** — `/usr/bin/bwrap` (Linux) ou `/usr/bin/sandbox-exec` (macOS). Se existe, é usado direto (`trustLevel = 'canonical'`). Defesa contra PATH-shim: o operator (ou attacker com $HOME) que plante `/tmp/evilbin/bwrap` early em `$PATH` perde para o canonical.

2. **PATH-resolved fallback** — quando o canonical não existe (Nix, Homebrew on Linux, custom build), `Bun.which()` resolve via `$PATH`. O path resolvido passa por **stat-check**:
   - Owner deve ser `root` (uid=0)
   - Mode bits **não** podem incluir world-write (0o002) nem group-write (0o020)
   
   Se algum dos checks falha, `trustLevel = 'path-resolved'` + warning(s) operator-visíveis. **NÃO refuse** — o sandbox ainda é montado; o operator vê a warning e decide. Trust model: "operator owns their own $HOME — se attacker comprometeu $HOME, sandbox é teatro de qualquer forma".

3. **Argv discipline** — o path resolvido (canonical OU path-resolved) é passado **literal** como `argv[0]` no `Bun.spawn(...)`. Kernel `execve()` não re-walk `$PATH`. Sem essa disciplina, o shim attack reabriria pelo lado do exec.

Trust marker + warnings persistem no `SandboxAvailability` retornado por `detectSandboxAvailability()` → telemetry → audit. `agent doctor` e `agent sandbox setup` renderizam as warnings para que postmortems correlacionem "rodava com bwrap não-canonical em /opt/bin" com qualquer incident downstream.

**macOS `/tmp` per-sandbox isolation (slice 156).** Linux derruba `/tmp` via `--tmpfs /tmp` no `bwrap`, isolando o tmpdir por sandbox. macOS não tem equivalente direto — pré-slice o SBPL profile concedia blanket `(allow file-write* (subpath "/tmp"))` + `(allow file-write* (subpath "/private/tmp"))`, deixando o host `/tmp` (e tudo que outros processos do operator escrevem lá) writable de dentro do sandbox.

- **Threat shape:** sandbox A escreve `/tmp/secret`. App não-sandboxed B (terminal do operator, browser, qualquer coisa) lê `/tmp/secret`. Cross-tenancy leak entre sandbox e host — exactly what o `--tmpfs /tmp` no Linux previne.
- **Capability:** `buildSbplProfile(profile, cwd, home, tmpdir?)` aceita um `tmpdir?: string` opcional. Quando setado, o profile emite scoped allow apenas sobre esse subpath em vez do blanket. Se o tmpdir cai sob `/tmp/`, o profile também emite a forma `/private<tmpdir>` (firmlink macOS `/tmp ↔ /private/tmp`). Demais prefixes (e.g. `/var/tmp/...`) recebem apenas a forma literal.
- **Caller responsibility (phase 2):** o caller que ativa `tmpdir` deve (1) `mkdir(tmpdir, { recursive: true, mode: 0o700 })` antes do `Bun.spawn(...)`; (2) propagar `TMPDIR=<tmpdir>` no env do inner process; (3) limpar o diretório no shutdown da sessão. O helper `defaultSandboxTmpdir(sessionId) → /tmp/forja-sb-<sessionId>` é a convention name; o caller pode customizar.
- **Residual risk documentado:** mesmo com tmpdir scoped, paths fora de `/tmp` referenciados por libraries de terceiros via env vars (`HOME`, `DARWIN_USER_TEMP_DIR`, etc) ainda podem fugir do scope. SBPL allow é defense in depth — operator que reuses `/tmp/forja-sb-XXX` paths entre sessões expõe o residual. Cleanup obrigatório.

**macOS `/tmp` per-sandbox isolation phase 2 (slice 157).** Phase 1 (slice 156) landou a capability isolada (option no SBPL builder); phase 2 wira os 3 production callers para usá-la com granularidade per-CLI-run uniforme.

- **Helper:** `acquireSandboxTmpdir({ sessionId, platform?, mkdir?, rm?, warn? })` no `sandbox-availability.ts`. Darwin: `mkdir(/tmp/forja-sb-<sessionId>, { recursive: true, mode: 0o700 })`, retorna `{ tmpdir, cleanup }`. Não-darwin: no-op shape (linux já isolado via `bwrap --tmpfs /tmp`). Failure mode: mkdir falha → invoca `warn` callback + retorna `tmpdir=undefined` → callers degradam ao blanket pre-slice-156 (graceful, nunca refuse).
- **Acquisition site:** o CLI bootstrap chama `acquireSandboxTmpdir({ sessionId: generateUlid() })` uma vez por invocação, registra `cleanup` em `process.on('exit'/SIGINT/SIGTERM)`, e forwarda o `tmpdir` por dois canais:
  - `constructBroker(mode, cwd, tmpdir)` → sandboxRunner closure passa pro `maybeWrapSandboxArgv` + `createSpawnBroker.env` inclui `TMPDIR=<tmpdir>`. O worker spawn vê o TMPDIR scoped e a SBPL profile cobre o subpath.
  - `HarnessConfig.sandboxTmpdir?: string` → loop threads pra (a) `ToolContext.sandboxTmpdir` (consumido por `grep` e outros tools que invocam `maybeWrapSandboxArgv` direto) e (b) `CreateBgManagerOptions.sandboxTmpdir` (consumido pelo bg spawn).
- **Granularidade per-CLI-run uniforme:** todos os spawns (worker + grep + bg subagents) compartilham `/tmp/forja-sb-<ULID>` da mesma invocação. Cross-spawn-same-session NÃO é boundary de segurança (mesmo operator) — o threat é sandbox↔host, fechado pelo scoped SBPL allow. Cache locality bonus: spawns sequenciais reaproveitam o mesmo dir (npm cache, pip wheels etc.) sem race entre processos paralelos do mesmo `forja`.
- **Env discipline:** cada Bun.spawn callsite faz merge explícito `{ ...scrubEnv(process.env), TMPDIR: tmpdir }` (bg) ou `{ ...process.env, TMPDIR: tmpdir }` (grep). TMPDIR fica fora do scrubEnv allowlist por padrão — o overlay é AFTER scrubEnv, garantindo que um attacker injetando TMPDIR via env não vença a scrub (scrub já dropou) E o overlay seta o valor correto.
- **Cleanup:** registrado pelo bootstrap em 3 signal handlers (`exit`, `SIGINT`, `SIGTERM`). Best-effort: rm errors são silenciados (a dir pode ter sido removida por concurrent signal, ou pelo operator). Orphans `/tmp/forja-sb-*` ficam pro `agent worktree gc` (slice futuro) ou pra varredura de OS `tmpwatch`. Idempotente — segundo cleanup é no-op.

**Env-scrub kernel-boundary parity macOS ↔ Linux (slice 162).** Linux usa `bwrap --clearenv --setenv KEY VAL ...` pra impor uma allowlist de env vars no kernel boundary do `execve`. macOS sandbox-exec não tem flag equivalente — pre-slice o inner process herdava o env do spawner verbatim, fazendo userspace `scrubEnv` ser a ÚNICA defesa contra exfil de credenciais que NÃO matchassem a denylist (`VAULT_ADDR`, `BW_SESSION`, `OP_CONNECT_TOKEN`, etc.).

- **Fix slice 162:** `buildSandboxExecArgv` (macOS) aceita `env?: NodeJS.ProcessEnv` e, quando set, wrappa o inner argv com `/usr/bin/env -i KEY=VAL ... --` no argv passado pro sandbox-exec. `env -i` é o userland clearenv POSIX — limpa o env e executa o próximo argv com APENAS os `KEY=VAL` literais explicitados. Resultado: o inner bash dentro do sandbox-exec vê SÓ os vars da `SANDBOX_SAFE_ENV_VARS` allowlist que estavam presentes no env fornecido.
- **Source of truth única:** `src/permissions/safe-env-vars.ts:SANDBOX_SAFE_ENV_VARS` é a lista canônica, consumida tanto pelo `appendEnvFlags` (Linux `--setenv`) quanto pelo `buildSandboxExecArgv` (macOS `env -i`). Mudanças na lista propagam pras duas plataformas via mesmo import.
- **PATH-shim resistance:** o wrapper usa `/usr/bin/env` literal (não bare `env`). Mirror de slice 154 — `execve` não re-walk `$PATH`, atacante não consegue plantar `/tmp/evilbin/env` pra interceptar o clearenv.
- **NUL byte safety:** vars com NUL no value são puladas (não roubam outros tokens da argv). Mesma defesa do `appendEnvFlags` Linux.
- **scrubEnv denylist expansion (slice 162 part 2):** complementa o sandbox-side com novas patterns no `src/sanitize/env.ts`: suffixes `_KEY`/`_AUTH`/`_BEARER`/`_CRED(S)?`/`_SESSION`/`_COOKIE`/`_PRIVATE_KEY` + service prefixes `VAULT_`/`BW_`/`LPASS_`/`LASTPASS_`/`OP_CONNECT_` + specific names `DOPPLER_TOKEN`/`INFISICAL_TOKEN`/`TWILIO_ACCOUNT_SID`. Defense in depth pros paths `host`/`degraded passthrough` onde sandbox wrap não fire — userspace scrub é a única camada.

### 6.6 Approval gate

| Condição | Decisão |
|---|---|
| static rule `deny` matched | `deny` |
| state == `refusing` | `deny` (fatal) |
| state == `degraded` **e** decision seria `allow` | `confirm` (forçado) |
| static rule `allow` matched **e** score < 0.4 **e** confidence != low | `allow` |
| static rule `allow` matched **e** (score ≥ 0.4 ou confidence == low) | `confirm` |
| static rule `ask` matched | `confirm` |
| nenhum match | `deny` (fail closed) |

**Slice 139 D1 nota:** linhas 4-5 acima foram revisadas. Anteriormente: "confidence == high" required for silent allow; "confidence < high" (incluindo medium) → confirm. Hoje: só `low` força confirm; `medium` é tratado como `high` para fim de gate (a contribuição da confidence-low pro score já está em §6.3 — `+0.30`, que sozinho cruza o `scoreConfirmThreshold = 0.4` quando combinado com qualquer outra feature mesmo benigna). Justificativa de calibração em §5.1.

Confirm produz preview estruturado:

```
Tool:           bash
Capabilities:   exec:shell, write-fs:./build/**, net-egress:registry.npmjs.org
Risk score:     0.62 (high)
  ├─ capability_risk:      +0.40 (write-fs)
  ├─ shell_chain:          +0.20 (&&)
  └─ classifier_adjust:    +0.02
Resolver:       bash@1.3 (confidence: high)
Sandbox:        cwd-rw-net (bwrap profile)
TTL if approved: session
Replay id:      ap_01H3K5...
```

Sem preview legível, sem aprovação. Modal opaco é débito de segurança.

### 6.7 Audit row para hook-rewritten args (slice 178 M4)

Quando uma chain de hooks `PreToolUse` retorna `updatedInput` que **passa** o engine re-check (`§6.6` aplicado contra os args mutados), o harness aplica `effectiveArgs = chain.updatedInput` e prossegue para execução. O `tool_calls.input` da row primária permanece com os args originais (audit baseline imutável); a row de approval primária (decided_by='policy') foi gravada antes do hook rodar.

Pra que a rewrite seja visível em queries forenses, o harness grava uma **segunda row em `approvals`** com:

- `decided_by = 'hook'`
- `decision = 'allow'`
- `reason = 'allow: hook updatedInput applied; args_hash <preHash> → <postHash>'`

`preHash` / `postHash` são os primeiros 16 chars de `canonicalHash(args)` (mesma primitiva que `failure_events` usa pro chain) — sort de chaves antes de hashar para que hooks que re-serializam o input com ordem de chaves diferente (Python dict, Go map) **não** sintetizem rewrite spuriosa. Quando `preHash == postHash` nenhuma row é escrita (hook re-emite verbatim, no-op).

Query forense canônica:

```sql
SELECT a.tool_call_id, a.reason, t.tool_name, m.session_id
FROM approvals a
JOIN tool_calls t ON a.tool_call_id = t.id
JOIN messages m ON t.message_id = m.id
WHERE a.decided_by = 'hook'
  AND a.decision = 'allow'
  AND a.reason LIKE 'allow: hook updatedInput applied%'
ORDER BY a.decided_at DESC;
```

Aggregações que esperam UMA approval row por toolCallId precisam contar `decided_by` separadamente; a row de hook não substitui a row primária, complementa.

---

## 7. Audit log (append-only, hash-chained, sealable)

### 7.1 Schema

```sql
CREATE TABLE approvals_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                       -- unix ms
  install_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_approval_id TEXT,                   -- subagent → ref pai
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  args_hash TEXT NOT NULL,                   -- sha256(canonical args)
  capabilities_json TEXT NOT NULL,
  decision TEXT NOT NULL,                    -- allow|deny|confirm-allowed|confirm-denied
  score REAL NOT NULL,
  score_components_json TEXT NOT NULL,
  confidence TEXT NOT NULL,
  classifier_hash TEXT,
  classifier_adjust REAL,
  policy_hash TEXT NOT NULL,
  sandbox_profile TEXT,
  ttl_expires_at INTEGER,
  reason_chain_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  this_hash TEXT NOT NULL                    -- sha256(prev_hash || canonical_row_minus_this_hash)
);

CREATE INDEX idx_session ON approvals_log(session_id);
CREATE INDEX idx_ts ON approvals_log(ts);
```

`args_hash` em vez de args brutos: PII e secrets não vazam em audit log persistido. Args brutos vivem só em SQLite de sessão (TTL curto) pra replay.

### 7.2 Hash chain

#### Genesis

Primeira decisão de uma installation:

```
prev_hash = "GENESIS:" || sha256(install_id || created_at_ms)
```

`install_id` = UUID v4 gerado em primeiro start, persistido em `~/.config/agent/install_id` com mode 0600. Re-rotaciona = nova chain (audit trail registra `chain_rotation` event).

#### Cadeia

```
this_hash = sha256(prev_hash || canonical_row)
canonical_row = JSON canonicalizado RFC 8785 de todos os campos exceto this_hash
```

#### Verificação

`verify_chain()` em SessionStart e sob comando `agent permission verify`:

```
walk seq=1..N:
  recompute this_hash from row
  compare with stored this_hash
  on mismatch → state = refusing, emit chain_break event with seq
```

#### Quebra de chain

Default response: state vai pra `refusing`. Não-recuperável sem ação humana:

| Flag | Comportamento |
|---|---|
| `--accept-broken-chain` | aceita chain quebrada; emit warning event; SIGNED log entry com user input; **não silencia em audits** (entry visível) |
| `--rotate-chain` | arquiva chain antiga em `approvals_log_archived_<ts>`; nova genesis com same install_id; novo seq 1; quarantine flag em queries até inspeção |

### 7.3 Sealing externo (opcional, recomendado pra audit-grade)

Hash chain local protege contra **edição parcial silenciosa**. Adversário com root pode reescrever tudo (incluindo recálculo de hashes). Sealing externo eleva o bar.

Configurações suportadas:

| Mecanismo | Implementação | Dependência |
|---|---|---|
| `worm-file` | append-only via `chattr +a` (ext4) ou WORM mount | Linux com permissão chattr |
| `s3-object-lock` | post hash em S3 com object-lock COMPLIANCE | AWS account, role |
| `rfc3161-tsa` | hash a cada N decisões enviado pra TSA com timestamp assinado | TSA acessível |
| `git-anchored` | hash periódico commitado em repo separado push em remote | git remote |
| `none` | (default) | — |

Política de sealing:

```toml
[seal]
mode = "rfc3161-tsa"            # ou outro
interval_decisions = 100         # a cada 100 decisões
interval_seconds = 3600          # ou a cada hora, o que vier antes
endpoint = "https://tsa.example.com"
on_failure = "degrade"           # ou "refuse"
```

Falha de sealing → state = `degraded` (default) ou `refusing` (strict). Sealing é **opcional**: deployment local-CLI pode rodar sem; deployment regulado **deve** habilitar.

#### 7.3.1 SealStore contract (slice 141 M1)

Cada um dos 4 backends acima implementa a interface `SealStore`:

```ts
interface SealStore {
  append(entry: SealEntry): { ok: true } | { ok: false; reason: string };
  list(): readonly SealEntry[];
  close(): void;
}

interface SealEntry {
  seq: number;     // FK pra approvals_log.seq
  ts: number;     // wall-clock ms
  hash: string;   // approvals_log.this_hash no momento do seal
}
```

**Wire format compartilhado:** todos os backends que persistem em arquivo (worm-file, git-anchored, rfc3161-tsa, s3-object-lock — cada um materializa o seal entry em uma linha NDJSON-like) usam `seq=<n>\tts=<n>\thash=<H>\n`. `verifySealAgainstChain` reads via `store.list()` sem dispatch — a interface é o único seam entre cross-backend.

**Cross-install seal binding (slice 128 R4 P0-Audit-1):** `verifySealAgainstChain(store, db, installId)` requer install_id no contrato — backend-agnostic. Reads `approvals_log` row by `seq`, refuses se `row.install_id !== installId`. Pre-fix, a função consultava sem filtro de install — atacante com DB-write podia inserir row pra install B com hash controlado + editar o seal file de install A pra apontar pra row de B → verify pra A succeedia contra row de B. Hoje a função pin a identity no boundary.

**Duplicate-seq replay defense (slice 129 R5 P1):** o append path do SealStore é best-effort idempotent (writers de-dupe antes do flush) mas backend hostil ou corrompido (S3 versioned object replay, disk recovery merge, file editado manualmente) pode emitir duas entries com mesmo seq + hashes diferentes. Pre-fix, `verifySealAgainstChain` validava cada entry contra o row do DB independentemente — primeira entry batia, segunda batia também (DB rows são keyed por seq sozinho, mesma lookup retornava mesmo row). Hoje a função recusa entries duplicadas via `seenSeqs: Set<number>` durante o walk — replay-amplification attack closed.

**Sealing scheduler seed (slice 128 R4 P0-Race-1):** `createSealingScheduler` lê `store.list()` no construtor e seeda `lastSealedSeq` com o max(entries[].seq). Pre-fix, dois processos forja concorrentes na mesma install ambos iniciavam com `lastSealedSeq = 0` e ambos appendavam `seq=N hash=H` ao mesmo seal file → duplicate entries. Seed do store.list() faz o segundo processo ver "já selei N" e noop. `store.list()` throwing (arquivo corrompido) cai pra fallback de 0 com aceitação do duplicate-on-first-tick risk; alternativa seria recusar construção e quebrar o pipeline inteiro por um seal file ruim — overcorrection.

### 7.4 Retenção

Default 90d. `vacuum` em SessionStart se rows > 100k. Retenção **não pode quebrar chain** — deletion respeita ordem e move rows pra `approvals_log_archived` com hash final preservado pra continuação.

---

## 8. TTL e scopes de grant

| Scope | Significado | TTL típico |
|---|---|---|
| `once` | uma única invocação, args exatos | imediato |
| `session` | até fim da session atual | sessão |
| `pattern:<glob>` | qualquer match desse pattern | 24h default, max 30d |
| `capability:<cap>+<scope>` | capability dentro do scope | 24h default, max 7d |

`once` é default sugerido pra primeira aprovação. UX promove pra `session` na N-ésima repetição da mesma capability+scope (anti approval-fatigue por agrupamento).

```sql
CREATE TABLE grants (
  id TEXT PRIMARY KEY,                       -- ULID
  scope_kind TEXT NOT NULL,                  -- pattern|capability
  scope_value TEXT NOT NULL,
  capability TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL,                  -- user|enterprise|project
  granted_reason TEXT,
  revoked_at INTEGER,
  revoked_reason TEXT
);
```

Grants são consultados com `WHERE expires_at > snapshot_ts AND revoked_at IS NULL`. `revoke` é ação user-acionável (`agent permission revoke <id>`) e idempotente.

---

## 9. Credential scoping

Sandbox sem rede não basta se `~/.aws/credentials` está montado readonly no FS visível. Cada profile declara o que **NÃO** está visível.

```toml
[sandbox.profile.cwd-rw]
hide_paths = [
  "~/.ssh", "~/.aws", "~/.config/gcloud",
  "~/.netrc", "~/.gnupg", "~/.docker/config.json",
  "~/.kube", "~/.npmrc", "~/.pypirc",
]
scrub_env = [
  "AWS_*", "GCP_*", "AZURE_*",
  "GITHUB_TOKEN", "GITLAB_TOKEN",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
  "*_TOKEN", "*_SECRET", "*_PASSWORD", "*_API_KEY",
]
```

Implementação:
- **hide_paths** → dirs: `--tmpfs <path>` (overlay vazio); files: `--ro-bind <empty-regular-file> <path>` (read-only sobre um arquivo regular vazio). Pré-fix os files usavam `--ro-bind /dev/null` (char device), mas ferramentas que leem esses paths como config (git 2.54 → `fatal: unknown error occurred while reading the configuration files`; npm; …) recusam um config não-regular — o masking QUEBRAVA git/npm dentro do sandbox. Arquivo regular vazio: a ferramenta vê config vazio (funciona), o conteúdo real fica escondido (sem vazar PII) e o bind read-only impede write-plant em `home-rw`. O source é um arquivo vazio session-cached criado host-side (lido pelo bwrap antes do namespace `--tmpfs /tmp`).
- **scrub_env** → engine constrói env limpo antes do exec; glob match contra keys; matched keys removed.

Reverter scrubbing exige capability `secret-access:<store>` autorizada, e tem TTL hardcoded `once` (não promovível).

---

## 10. Subagent inheritance (formal)

Subagent é spawn via tool. Engine vê spawn como tool call e aplica pipeline normal.

### 10.1 Capability set efetivo

```
parent_caps     = capabilities efetivas do agente pai (snapshot no momento do spawn)
declared_caps   = capabilities solicitadas no spawn args (formato: list of capability strings)

effective_caps  = parent_caps ∩ declared_caps
```

Se `declared_caps ⊄ parent_caps` → `deny(reason="subagent_escalation", excess=...)`.

Se `declared_caps` vazio → subagent recebe **nenhuma** capability (pure-LLM subagent, sem tools side effect).

### 10.2 TTL e estado

- `subagent.ttl ≤ parent.ttl_remaining`
- `subagent.session_id` é child do `parent.session_id`
- Audit row do subagent tem `parent_approval_id` referenciado
- Grants: subagent usa grants do pai (read), nunca cria novos grants persistentes (write em `grants` é deny pra subagent)

### 10.3 Escape impossível

Não há flag, prompt, ou config que permita subagent ter capability fora de `parent_caps`. Engine codifica isso. Override exige edição de policy enterprise (locked rule), nunca runtime.

---

## 11. Protected paths (não-overridáveis)

Capabilities `env-mutate` e `agent-mutate` **nunca** auto-allow, mesmo com static rule.

Paths protegidos em três tiers. **Hardcoded na engine, não em policy file**. Policy não flexibiliza. Locked enterprise rule pode adicionar paths protegidos; nunca remover. Tentativa de remoção em policy load → `policy_invalid: protected_paths_redefined`.

### 11.1 Tier `deny` — refuse direto em qualquer op

Pseudofs do kernel + sockets runtime de daemons privilegiados. Read e write ambos negados (read de `/proc/<pid>/environ` é o shape canônico de credential-exfil; write de `/var/run/docker.sock` é game over).

```
/proc/, /sys/, /boot/, /dev/
/run/, /var/run/      (docker.sock, postgresql.sock, dbus — slice 180)
```

**Carve-out `/dev` (pseudo-devices seguros).** O deny de `/dev/` exclui um conjunto fixo de pseudo-devices kernel-managed inofensivos pra read+write: `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`, `/dev/tty`, `/dev/std{in,out,err}`, e o prefixo `/dev/fd/` (fds do próprio processo). Sem o carve-out, `> /dev/null` / `2>/dev/null` (o alvo de redirect mais comum do shell) era recusado, bloqueando uma fatia enorme de comandos normais. Continuam deny: block devices (`/dev/sda*`), memória crua (`/dev/mem`, `/dev/kmem`, `/dev/port`) e as pseudo-paths bash-virtuais de rede (`/dev/tcp/<host>/<port>`, `/dev/udp/...` — reverse-shell-via-redirect, §5.2). Lista canônica em `protected_paths.ts:SYSTEM_DEV_SAFE_EXACT` + `isDevSafe`.

### 11.2 Tier `escalate` — write/delete escala pra confirm

Reads passam (operador legitimamente lê `/etc/hosts`, `~/.bashrc`).

```
/etc/                              (qualquer)
~/.bashrc, .zshrc, .zshenv, .zprofile, .profile, .bash_profile, .bash_aliases
~/.config/fish/config.fish, ~/.tmux.conf, ~/.inputrc
~/.netrc, ~/.npmrc, ~/.pypirc
~/.gitconfig, ~/.git-credentials, ~/.boto
~/.docker/config.json, ~/.cargo/credentials.toml
~/.config/agent/, ~/.config/claude/, ~/.config/forja/
~/.config/gcloud/, ~/.config/azure/, ~/.config/op/, ~/.config/sops/
~/.ssh/, ~/.aws/, ~/.gnupg/, ~/.kube/
~/.docker/, ~/.cargo/
~/.terraform.d/, ~/.ansible/, ~/.rustup/
~/.subversion/auth/
~/.local/share/forja/                (audit DB; sandbox-write evade chain)
.git/, .agent/, .claude/             (project-relative)
```

A lista de tilde-paths está **sincronizada com `HIDE_PATHS_DIRS` / `HIDE_PATHS_FILES`** (§9 sandbox-side credential masking). Pré-slice 180 as duas listas divergiram em ~10 entries, deixando dirs sandbox-mascarados mas engine-permitidos quando rodando em `degraded` (sandbox indisponível) ou `host` profile. Sincronização fechada via slice 180.

### 11.3 Catastrophic deletion blocklist

`rm`/`rmdir`/`find -delete` em system roots: hardcoded em §5.2 + path resolver §4.3 resolvem para root/home antes do match:

```
POSIX/Linux:  /, /etc, /usr, /usr/local, /var, /lib, /lib64, /bin, /sbin,
              /boot, /root, /opt, /home, /dev, /proc, /sys,
              /run, /var/run, /srv, /mnt, /media
macOS:        /Users, /Applications, /Library, /System, /private
```

Match é exato (não prefix): `rm -rf /etc` refuse hard; `rm /etc/agent/old.conf` passa pelo classifier escalate. Trade-off: `rm /home/alice/junk.txt` passa (alice's home, legitimately rm-able); `rm -rf /home` refuse. Operator que quer remoção em system root usa `--sandbox-host` + policy explícita.

---

## 12. Policy lifecycle

### 12.1 Load order

```
1. enterprise:  /etc/agent/policy.toml         (root-owned, 0644)
2. user:        ~/.config/agent/policy.toml    (user-owned, 0600)
3. project:     ./.agent/policy.toml           (committed, hash-tracked)
4. session:     flags + interactive grants     (in-memory)
```

Em `init` → `loading-policy`: carrega cada nível, valida, merge com hierarchy rules.

### 12.2 Validação

Policy passa por:

1. **Schema check** (TOML schema canônico).
2. **Glob compilability** (todos os scopes parseiam).
3. **Hierarchy consistency**: project não pode `allow` capability que enterprise tem como `deny` com `locked = true`.
4. **Hardcoded compatibility**: policy não pode redefinir protected paths (§11).
5. **Resolver references**: tools referenciados em policy existem no registry.

Falha em qualquer passo → carga aborta, policy anterior preservada (ou state = refusing se primeira carga).

### 12.3 Reload (hot)

File-watch nos arquivos de policy. Mudança → re-validate em background; se válido, swap atômico:

```
1. lock(policy_swap_mutex)
2. new_policy = compile(file)
3. if validate(new_policy) fails:
     emit policy_reload_failed event with details
     keep old_policy
     unlock
     return
4. policy_hash_old = current.hash
5. current = new_policy
6. emit policy_reloaded event with old_hash, new_hash
7. unlock
```

Decisão em curso usa snapshot capturado no estágio [1] do pipeline. Próxima decisão usa policy nova.

### 12.4 Rollback

Policy pode ser revertida via:

- `agent permission policy rollback` → reverte pra última policy válida (até 5 mantidas em `~/.cache/agent/policy_history/`).
- Edição manual do arquivo (file-watch dispara reload).

Cada rollback é audit event.

---

## 13. Platform provisioning

Sandbox não é dependência embutida; é capability **detectada e provisionada**. Tentar bundlar binário cross-platform (Linux + macOS + WSL + variantes) é caminho garantido pra inferno de manutenção. Engine detecta, orienta, valida e degrada explicitamente — nunca instala silenciosamente, nunca esconde ausência.

### 13.1 Filosofia: detect, don't distribute

Anti-patterns rejeitados:

- **Bundlar `bwrap` binário** com o agente. Quebra em qualquer libc/kernel diferente; vira mantenedor de distro acidental.
- **Esconder ausência de sandbox.** Usuário precisa saber que está em modo unsafe. Banner não-suprimível.
- **Auto-sudo silencioso pra instalar dependência.** Engine sugere comando; user executa. Privilege escalation by agent é vetor, não feature.
- **"Funciona out of the box em todo lugar."** Marketing. Realidade: sandbox é OS-specific e exige cooperação do user em primeira execução.

Anti-pattern aceitável-mas-evitar em local-CLI: **Docker como sandbox padrão**. Portável e funciona, mas peso enorme pra UX interativa. Aceitável em ambiente CI ou deployment multi-tenant; ruim pra local.

### 13.2 Support tiers

| Tier | Plataforma | Mecanismo | Status |
|---|---|---|---|
| **First-class** | Linux (kernel ≥ 4.18 com user namespaces enabled) | bwrap | Suportado, testado |
| **First-class** | WSL2 (Ubuntu, Debian, Fedora) | bwrap | Suportado, testado |
| **Partial** | macOS 11+ | sandbox-exec (sbpl profile) | Suportado; profiles limitados; FS bind tem quirks |
| **Limited** | Windows native (não-WSL) | sem sandbox real; degraded forçado | Não recomendado em v2; instruir uso de WSL |
| **Out of scope** | Linux com kernel < 4.18 ou user namespaces desabilitados | — | refusing ou host com confirm forçado |
| **Out of scope** | macOS com SIP off ou sandbox-exec deprecated em versão futura | — | refusing |

Cada tier define `capability_ceiling` — quais sandbox profiles são alcançáveis. Linux first-class: `[ro, cwd-rw, cwd-rw-net, home-rw, host]`. macOS partial: `[ro, cwd-rw, host]` (net filtering via sandbox-exec é limitado).

### 13.3 `forja doctor` (health check)

Comando idempotente, read-only, sem side effects:

```
$ forja doctor

Forja health check
──────────────────
OS:                   Linux 6.18 Manjaro                       OK
User namespaces:      enabled                                  OK
Sandbox binary:       bwrap 0.10.0 (/usr/bin/bwrap)            OK
Net filtering:        nftables 1.0.9                           OK
SELinux/AppArmor:     apparmor (complain mode)                 WARN
Capability profile:   cwd-rw-net selectable                    OK
Policy load:          enterprise=none user=ok project=ok       OK
Hash chain:           intact (seq 4821, last seal 4h ago)      OK
Sandbox enforcement:  bwrap available; broker resolves to spawn OK
External sealing:     rfc3161-tsa (last success 4h ago)        OK
Classifier:           v0.3 (last response 142ms)               OK
Engine state:         ready                                    OK

Capability ceiling: [ro, cwd-rw, cwd-rw-net, home-rw, host]
Engine version: 2.0.1
Conformance suite:  142/142 passing (last run 2d ago)

Warnings:
  - AppArmor in complain mode; consider enforce for stronger isolation
```

**Check `sandbox_enforcement`** (slice review-broker-default). Distinto do `sandbox binary` check (que reporta apenas presença do binário). Esse check responde: "bash spawns ESTÃO sendo wrapped na boot atual?". Re-probe `detectSandboxAvailability` localmente — não confia no status do check anterior porque `sandbox binary` retorna `warn` tanto para binary-absent quanto para non-canonical-but-present (implicações de enforcement diferentes). Saída:

- `ok` quando sandbox binary presente → broker default resolve pra spawn → bash wrapped.
- `warn` quando sandbox binary ausente → broker default cai pra in-process → engine permission floors são a única defesa.

Operador que força `--broker in-process` em host com sandbox disponível NÃO é detectado por esse check (doctor é standalone — não tem CLI args da sessão real). O REPL banner §UI 4.10.9 surfaceia esse override no boot via `SandboxEnforcementSnapshot` (próximo §13.7).

`--json` para parse por hooks externos. Exit code != 0 se qualquer check `FAIL`; warnings não falham. Checks críticos sempre live; não-críticos (versões de kernel/pkg) com cache de 60s.

### 13.4 `forja sandbox setup` (bootstrap guiado)

Comando interativo, idempotente, **nunca executa sudo sem confirmação explícita**.

```
$ forja sandbox setup

Forja sandbox setup
───────────────────
Detected: Linux Manjaro (kernel 6.18)
Sandbox status: bwrap not found

Recommended action:
  Install bubblewrap via package manager.

Options:
  [1] Show install command (recommended)
  [2] Run install command (requires sudo)
  [3] Continue without sandbox (UNSAFE — agent runs with host permissions)
  [4] Cancel

Choice: 1

Run this command in another terminal:
  sudo pacman -S bubblewrap

After installation, re-run: forja doctor
```

Opção `[2]` exibe o comando exato e pede **segunda confirmação** antes de executar. Auto-run só com `--yes` explícito (CI use case, requer policy `ci_mode_acknowledged = true`).

Opção `[3]` exige confirmação dupla, grava `unsafe_mode_acknowledged_at` em audit log, mantém banner de warning persistente em toda sessão.

Detecção de package manager (best-effort, tabela hardcoded):

| Distro hint | Comando |
|---|---|
| `/etc/debian_version` | `sudo apt install bubblewrap` |
| `/etc/arch-release` | `sudo pacman -S bubblewrap` |
| `/etc/fedora-release` | `sudo dnf install bubblewrap` |
| `/etc/alpine-release` | `sudo apk add bubblewrap` |
| `/etc/nixos/configuration.nix` | manual: adicionar `pkgs.bubblewrap` |
| macOS (Homebrew detected) | manual: sandbox-exec é built-in; orienta config |
| nenhum reconhecido | comando genérico + link doc |

### 13.5 First-boot UX

Primeira execução sem sandbox configurado:

```
Forja first-boot setup
──────────────────────

Forja runs LLM-orchestrated tools that may execute shell commands,
edit files, and access the network. To contain blast radius, Forja
recommends running tools inside an OS sandbox.

Detected: Linux Manjaro
Sandbox status: NOT CONFIGURED

How would you like to proceed?

  [1] Set up sandbox now (recommended)
  [2] Continue with sandbox disabled (UNSAFE)
  [3] Continue with confirm-on-every-action (slow but safe)
  [4] Exit

Choice:
```

- **[1]** → entra em `forja sandbox setup`
- **[2]** → grava ack em audit log; banner permanente; todas decisões `allow` viram `confirm` (state = degraded)
- **[3]** → modo high-friction; útil pra avaliar antes de instalar sandbox

Nunca há opção silenciosa "skip and don't ask again". Re-prompt em toda sessão se sandbox continua ausente; suprimível só com `~/.config/forja/sandbox_skip` criado via `--i-know-what-im-doing`.

### 13.6 Degradação explícita

Sandbox indisponível mid-session (binary removido, kernel feature toggled off) → engine detecta no próximo `engine.state()` ou em health re-check (§13.8), transição `ready → degraded`, emit event, **banner no terminal**:

```
⚠ Sandbox no longer available (bwrap binary missing)
  All tool calls now require manual confirmation.
  Run 'forja doctor' to investigate.
```

Banner é:
- Não-suprimível durante a sessão atual
- Re-exibido a cada N tool calls (default 10)
- Logado em audit como `sandbox_degraded_active`

### 13.7 Broker/worker architecture

Engine CLI **nunca** chama `exec()` direto. Toda invocação de tool com exec capability passa por broker → worker.

```
forja CLI (main process)
  │
  ├─ permission engine        (decide allow/deny + sandbox profile)
  │
  ├─ broker (long-lived)      (recebe pedido, monta sandbox, spawn worker)
  │     │
  │     └─ worker (per call)  (processo descartável dentro do sandbox)
  │            │
  │            └─ tool exec   (bwrap-wrapped)
  │
  └─ harness loop             (LLM ↔ engine ↔ broker)
```

Justificativa:
- **CLI main não tem `exec` privilege.** Se main é comprometido (bug, prompt injection no harness), atacante não ganha exec direto.
- **Worker é descartável.** Estado de tool não vaza pra próximo call.
- **Broker é o único ponto que monta sandbox.** Auditável; mock-able em testes.
- **Worker killable.** Tool travado não trava main.

Trade-off: latência (spawn de worker custa ~10ms em Linux). Aceitável; comparável ao que harness já gasta em IO/LLM.

#### 13.7.1 Broker mode resolver (default dinâmico)

O CLI suporta dois modos:

- **`in-process`** — broker executa worker logic dentro do main process. Cheap (~0 spawn latency), mas worker NÃO está em processo separado wrapped por bwrap. Engine permission floors são a única defesa.
- **`spawn`** — broker forka um worker child wrapped pelo sandbox tool (bwrap no Linux, sandbox-exec no macOS). Isolation real ao custo de ~10ms por call.

**Default = `spawn` quando sandbox tool está disponível** (slice review-broker-default). Resolução em `bootstrap.ts`:

```ts
const sandboxAvail = detectSandboxAvailability();
const resolvedBrokerMode =
  input.brokerMode ?? (sandboxAvail.available ? 'spawn' : 'in-process');
```

Operator pode forçar `--broker in-process` em host com sandbox disponível (debugging / perf testing); nesse caso o REPL banner surfaceia warning `operator-override` (§13.7.3).

**Compiled binary (`bun build --compile`).** O caminho `import.meta.dir` começa com `/$bunfs/` em runtime. Worker self-execa via `process.execPath` com env `FORJA_BROKER_WORKER=1`; `src/cli/index.ts` checa essa env no boot e despacha pra `runWorkerProcess()` antes de qualquer outra init — sem temp files, sem second binary, sem asset extraction.

#### 13.7.2 `SandboxEnforcementSnapshot`

Após resolver o broker mode, bootstrap calcula um snapshot:

```ts
type SandboxEnforcementSnapshot =
  | { active: true;  tool: 'bwrap' | 'sandbox-exec'; reason: 'active' }
  | { active: false; tool: null;                     reason: 'no-tool' }
  | { active: false; tool: 'bwrap' | 'sandbox-exec'; reason: 'operator-override' }
  | { active: false; tool: null;                     reason: 'degraded-passthrough' };
```

| `reason` | Quando |
|---|---|
| `active` | broker resolveu pra spawn + sandbox tool presente; bash spawns wrapped |
| `no-tool` | sandbox tool ausente; broker caiu pra in-process |
| `operator-override` | tool presente mas operator forçou `--broker in-process` |
| `degraded-passthrough` | broker spawn mas tool sumiu/falhou; passthrough sem wrap |

Snapshot é parte de `BootstrapResult`. REPL consome no boot pra emitir o status correto. Discriminator union com exhaustive `switch` (default `never`) garante coverage compile-time de novos estados.

#### 13.7.3 Integração com REPL banner

O banner (§UI 4.10.9) renderiza o snapshot diferenciado por estado:

- **`active`** — terceira linha inline no `session-banner` (sem leading blank), paint `secondary`: `✓ sandbox enforcement active (<tool>)`. Posture afirmativa, parte do frame.
- **`no-tool`** — evento separado `warn` (com leading blank), instrução pra rodar `forja sandbox setup`.
- **`operator-override`** — `warn` separado, explicação de que `--broker in-process` desabilitou wrap.
- **`degraded-passthrough`** — `error` separado, instrução pra rodar `forja doctor`.

A linha afirmativa fica DENTRO do banner pra não competir com warnings que precisam de emphasis; os três estados degradados ficam FORA, com leading blank, pra ler como alerta.

### 13.8 Health re-check contínuo

Doctor checks rodam:
- SessionStart (obrigatório; falha em check crítico = state refusing)
- A cada N tool calls (default 50)
- Sob comando explícito `forja doctor`
- Em transição `ready ↔ degraded` (re-confirma estado)

Cache de 60s pra checks não-críticos (kernel features, pkg versions). Checks críticos (bwrap binary presente, policy hash, hash chain integrity) sempre live.

### 13.9 Vetores adversariais em provisionamento

| Vetor | Mitigação |
|---|---|
| Atacante propõe install command modificado | Engine **só sugere** comandos da tabela hardcoded por distro; não aceita comando vindo de LLM ou MCP |
| `forja sandbox setup` chamado por subagent | Bloqueado: capability `agent-mutate` requerida; sempre confirm humano; never via subagent |
| Atacante substitui `bwrap` binary | Out of scope (root local); `doctor` reporta path e versão; user pode verificar checksum manual |
| Race: sandbox aparenta presente em doctor, somem mid-call | Worker invocation falha com `sandbox_unavailable`; transição pra degraded; call atual é deny |
| Setup auto-run em CI sem sandbox real | `--yes` exige policy `ci_mode_acknowledged = true`; default rejeita |
| Distro detection enganada por arquivo falso em `/etc/` | Detecção é best-effort e só orienta texto; nenhum comando é auto-executado sem confirmação explícita do user |

### 13.10 Mensagem central

Sandbox **não é feature opcional** nem "modo enterprise". É **parte do runtime model**. Roda sem? Sim, mas com banner permanente e fricção alta — comunicado explicitamente, nunca implícito.

User está executando modelo probabilístico com acesso a terminal. Tratar isso como engenharia de sistemas significa: **detectar, orientar, validar, degradar com transparência**. Não significa `npm install magic-security`.

---

## 14. MCP trust model

### 13.1 Manifest

MCP server fornece manifest declarando capabilities possíveis:

```json
{
  "name": "github-mcp",
  "version": "1.2.0",
  "capabilities_declared": ["net-egress:api.github.com", "read-fs:./", "git-write:*"],
  "tools": [
    {
      "name": "create_issue",
      "capabilities_used": ["net-egress:api.github.com"],
      "resolver": { "type": "static", "capabilities": ["net-egress:api.github.com"] }
    },
    ...
  ],
  "manifest_signature": null
}
```

### 13.2 Trust prompt

Primeiro contato com MCP server: hash do manifest + nome + lista de tools mostrados ao user. Trust prompt explícito.

Trust persistido em:

```sql
CREATE TABLE mcp_trust (
  server_name TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL,
  trusted_at INTEGER NOT NULL,
  trusted_by TEXT NOT NULL,
  capabilities_declared_json TEXT NOT NULL
);
```

### 13.3 Hash mismatch

Manifest mudou desde último trust → tools do server **quarentinados** (invisíveis ao modelo) até re-trust. Engine não invoca, mesmo se policy permitiria.

### 13.4 Capability ceiling

Engine refuse permitir capability que excede `capabilities_declared` do manifest. Tool tentando consumir além → `deny(reason="mcp_capability_breach")`.

### 13.5 Manifest signing (v2 status)

V2 **não exige** manifest assinado. Documentado como vetor aceito (server hostil pode declarar manifest enganoso; usuário deve fazer due diligence). V3 alvo: assinatura opcional via Sigstore.

---

## 15. Threat model da engine

A engine é o gate. Comprometê-la é jogo perdido. Quem ataca a engine, e como nos defendemos.

### 14.1 Vetores

| Vetor | Mitigação |
|---|---|
| **Engine binary trocado** | Update assinado (Sigstore/cosign); `agent --verify` confere antes de exec; unsigned = refuse |
| **`LD_PRELOAD` injetando lib hostil** | Out of scope (root local); documentado; deployment regulado deve usar OS-level mitigations (selinux, apparmor) |
| **Policy file editada por terceiro** | enterprise: root-owned 0644; user: 0600; project: PR review é gate; hash gravado em audit log permite forensics |
| **install_id roubado** | Permite forjar genesis; mitigação: file mode 0600 + diretório protegido; rotação opcional invalida chain anterior |
| **SQLite db corrompido / substituído** | `PRAGMA integrity_check` em SessionStart; `verify_chain()` antes de aceitar; sealing externo é defesa real |
| **Engine bug (e.g., glob compiler com OOB)** | Conformance suite + fuzzing (§16.4); panic = state refusing |
| **Race em concorrência** | Mutex de sessão; snapshot de policy por decisão; conformance test concurrency cases |
| **Classifier model trocado** | classifier_hash gravado em audit; mismatch entre invocações = warning event |
| **Time manipulation (clock fwd/back)** | TTL relative timestamps com monotonic clock onde possível; abrupt jump > 1h = warning event. **Audit-write-side forgery defense (slice 129 R5 P0 / slice 141 M4):** `audit.emit` recusa `ts > now + 1h` como suspeita de forgery — atacante com tool path controlado poderia injetar ts arbitrariamente no futuro, fazendo TTL filters / rate-limits / quarantine windows misfirearem. Refuse no boundary é hard validation, não warning. `now-1h..now+1h` é a janela válida pra ts caller-supplied. |
| **Resolver TOML / JS executado com privilégio** | Resolvers MCP em worker isolado; resolvers builtin são código compilado (não eval) |

### 14.2 Bootstrap

Primeiro start:

1. Verifica binary signature (signed release) ou aceita unsigned com explicit `--allow-unsigned` (audit log entry).
2. Cria `~/.config/agent/install_id` (UUID, mode 0600).
3. Cria `~/.config/agent/policy.toml` skeleton se ausente.
4. Genesis hash chain (§7.2).
5. State → ready.

### 14.3 O que é assumido (não defendido)

- Adversário com root local: pode tudo. Engine assume userspace honesto.
- Compromise do classifier model: bound de ±0.2 + `required: false` default limita dano.
- Compromise de MCP server confiado: trust prompt + hash chain + capability ceiling é o limite; código MCP não é inspecionado.
- Side-channel timing entre decisões: ignorado (nicho).

---

## 16. Conformance suite

Sem golden tests, "determinístico" é palavra. Suite obrigatória pra GA.

### 15.1 Format

Casos em YAML, um arquivo por categoria:

```yaml
# tests/conformance/static_rules/deny_precedence.yaml
- name: "deny in higher hierarchy beats allow in lower"
  setup:
    enterprise_policy: |
      [[deny]]
      capability = "write-fs"
      scope = "/etc/**"
      locked = true
    project_policy: |
      [[allow]]
      capability = "write-fs"
      scope = "**"
  input:
    tool: "write_file"
    args: { file_path: "/etc/foo.conf", content: "x" }
    cwd: "/tmp/proj"
  expect:
    decision: "deny"
    reason_substring: "enterprise_deny"
    score_lte: 1.0
```

### 15.2 Categorias e mínimos

| Categoria | Casos mínimos |
|---|---|
| Static rule matching (deny precedence, hierarchy, locked) | 20 |
| Capability resolver per builtin tool | 30 (3 cada × 10 tools) |
| Bash resolver adversariais (eval, $(), redirects, etc) | 25 |
| Path traversal / symlink escape | 15 |
| Hash chain (genesis, append, verify, broken) | 8 |
| TTL expiry edge cases | 6 |
| Subagent intersection | 6 |
| Protected paths immunity | 5 |
| Concurrency (parallel calls within session, policy reload mid-decision) | 5 |
| Score determinism (same input = same score) | 10 |
| Sandbox profile selection tie-break | 6 |
| **Total mínimo pra GA** | **136** |

### 15.3 Execução

```bash
agent permission test                  # roda suite
agent permission test --filter bash    # subset
agent permission test --golden-update  # regenerate goldens (CI gate)
```

Exit code != 0 = release blocker.

### 15.4 Fuzzing

Além de goldens, fuzz harness em CI:
- glob compiler (random byte strings → no panic, no OOB)
- bash resolver (random shell snippets → no panic, sempre Conservative ou Refuse em casos esquisitos)
- policy parser (random TOML → no crash)
- hash chain verify (corrupted rows → state=refusing, no panic)

Target: 10⁹ iterations sem crash novo entre releases.

---

## 17. Replay tool

Reprodutibilidade auditável é requisito (§1.8).

```bash
agent permission replay <approval_id>
agent permission replay <approval_id> --against-current-policy
agent permission diff <approval_id_1> <approval_id_2>
```

### 16.1 Inputs preservados

Pra replay, audit row tem:
- `args_hash` (lookup em sessão SQLite enquanto sessão viva)
- `capabilities_json`
- `policy_hash` (lookup em `policy_archive`)
- `resolver_version`
- `classifier_hash`
- `score_components_json`

Args brutos vivem em SQLite de sessão (TTL = retenção de sessão, default 30d). Após TTL, replay perde args mas mantém capabilities.

### 16.2 Modos

| Modo | O que faz |
|---|---|
| default | replay com policy original; deve produzir mesma decisão (verifica determinismo) |
| `--against-current-policy` | replay com policy atual; mostra diff |
| `--without-classifier` | força score determinístico puro; mostra impact do classifier |

Output:

```
Replay ap_01H3K5QXR...:
  Tool: bash
  Decision (original): confirm-allowed
  Decision (replay): confirm-allowed              ✓ deterministic
  Decision (against current): allow                ⚠ policy drift
    Diff: deny rule [[deny]] capability="exec" scope="/tmp/**" was removed in commit abc123
```

### 16.3 Use cases

- Pós-incidente: "qual decisão liberou X?"
- Policy review: "quantas decisões mudariam com essa nova rule?"
- Calibração: "score deu 0.4 mas humano clicou deny — feature pra adicionar?"

---

## 18. Observability

Cada decisão emite event:

```json
{
  "ts": 1731000000000,
  "kind": "permission.decision",
  "tool": "bash",
  "tool_version": "1.0.0",
  "resolver_version": "bash@1.3",
  "capabilities": ["exec:shell", "write-fs:./build/**"],
  "decision": "confirm-allowed",
  "score": 0.62,
  "score_components": {
    "capability_risk": 0.40,
    "shell_chain": 0.20,
    "classifier_adjust": 0.02
  },
  "confidence": "high",
  "policy_hash": "sha256:...",
  "classifier_hash": "v0.3",
  "sandbox_profile": "cwd-rw-net",
  "ttl_expires_at": 1731086400000,
  "approval_id": "ap_01H...",
  "parent_approval_id": null,
  "engine_state": "ready"
}
```

OTEL export com scrubbing. Métricas chave:

| Métrica | Alarme |
|---|---|
| `approval_rate{decision}` | drift > 20% week-over-week |
| `score_distribution` (histogram) | P50 > 0.5 (policy frouxa) |
| `classifier_unavailable_total` | > 5% das decisões |
| `chain_verification_failures_total` | > 0 = **P0** |
| `sealing_failures_total` | > 0 em strict mode = **P0** |
| `state_transitions{from,to}` | qualquer transição pra `refusing` = **P0** |
| `approval_fatigue_proxy` (% allow clickado < 1s) | > 30% indica calibração ruim |
| `policy_reload_failures_total` | > 0 indica policy drift |

---

## 19. Migration v1 → v2

Não-breaking pra usuário; breaking pra implementadores de tool.

### Fase 1 (compat): v2 lê policy v1
- `Bash(npm test)` → traduzido pra `capability=exec:shell, match.command_prefix="npm test", scope=*`.
- Regras sem TTL ganham `ttl=session`.
- Tools sem manifest de capabilities ganham `capability=exec:shell` conservador (escala approval).
- Hash chain inicia em primeira decisão pós-upgrade (genesis nesse ponto).

### Fase 2 (incentivo): warning em v1-only
- Tool sem manifest emite warning em SessionStart.
- Policy sem capability declarada idem.
- Conformance suite tests v2-only path.

### Fase 3 (cutover): v3 remove tradução v1
- Policy v1 deixa de carregar; migração obrigatória.

Tempo entre fases: ≥ 2 releases minor cada.

---

## 20. Não-defendido (escopo honesto)

| Vetor | Decisão |
|---|---|
| Adversário com root local | fora de escopo; engine assume userspace honesto |
| `LD_PRELOAD` / kernel module hostil | fora de escopo; recomenda OS hardening |
| Compromise de MCP server confiado | trust prompt + hash chain + capability ceiling = limite; código MCP não inspecionado |
| Side-channel timing | ignorado |
| Modelo gerando comando equivalente fora de pattern conhecido (`python -c "import os; os.remove(...)"`) | mitigado pelo capability resolver do tool python; **NÃO** mitigado se tool python não declara `delete-fs` |
| Approval fatigue real (user clica allow sem ler) | mitigado por `once` default + preview + métrica de fadiga; **não eliminado** |
| Classifier ML envenenado | mitigado por hint-only + bound ±0.2; nunca elimina deny determinístico |
| Compromise do binário antes de update verification | depende de update mechanism; first-install é trust on first use |
| Manifest MCP enganoso (server declara capability menor que usa) | mitigado por capability ceiling no engine, mas server pode operar fora dele com side effects via output (limited mitigation) |

---

## 21. Open questions

1. **Capability resolver dinâmico para `bash`.** AST parser cobre 80%; eval/dynamic content fica em `Refuse` ou `low confidence`. Vale investir em análise simbólica? Custo > benefício até calibração mostrar volume de Refuse intolerável.
2. **Score weights drift.** Baseline é defensável, não otimal. Plano em §6.3.2; primeiro deploy em telemetria piloto antes de GA pública.
3. **Locked enterprise grants vs user agency.** UX de "your admin blocked this" precisa existir antes de v2 GA. Atual: erro técnico, não ação user. Tracked.
4. **Cross-session pattern grants.** Default conservador (`session` only). `pattern` exige confirmação separada. Reabrir após calibração mostrar volume de re-aprovação.
5. **Manifest signing (MCP).** V2 sem; V3 alvo Sigstore.
6. **Sealing default.** Local-CLI sem; deployment regulado com. Detectar contexto e sugerir? Trade-off entre fricção e segurança.
7. **Snapshot de policy mid-decision (TOCTOU).** Atual: snapshot por decisão. Custo: cópia de struct compilada. Aceitável até policies grandes (> 10k regras) → otimizar com COW se necessário.

---

## 22. Referências cruzadas

- **`CONTRACTS.md` §9** — contrato externo Tool Registry ↔ Engine (v1 ainda autoritativo na fronteira)
- **`SECURITY_GUIDELINE.md` §1, §3** — threat model de onde vêm os requisitos
- **`AUDIT.md`** — formato de event log e retenção
- **`APP_SANDBOX.md`** — fundamentos de bwrap/sandbox-exec
- **`MCP.md`** — manifest de capabilities pra MCP tools
- **`PERFORMANCE.md` §8** — limits de concorrência e budget

V1 (`CONTRACTS.md` §9) é a interface externa; este doc é a implementação interna. Quando divergirem, **interface vence** até v3.

---

## 23. Critério de production-ready

Checklist objetivo. Marca pra release:

- [ ] Conformance suite ≥ 136 casos passando
- [ ] Fuzz harness 10⁹ iterations sem crash novo
- [ ] Bash resolver registry cobre top 30 commands
- [ ] Path resolver com symlink escape testado
- [ ] Hash chain genesis + verify + rotação testados
- [ ] Sealing externo configurável e testado em ≥ 1 backend (recomendado: rfc3161-tsa)
- [ ] State machine completa com transitions audit-loggadas
- [ ] Replay tool funcional pra todas categorias de decisão
- [ ] Telemetria com scrubbing implementada
- [ ] Threat model § 14 review por terceiro independente
- [ ] Calibração baseline-v2.0 validada em deployment piloto ≥ 30d
- [ ] Migration path v1 testado com policies reais

Tudo marcado = production-ready pra local-CLI. Pra deployment regulado (healthcare, fintech) adicionar:

- [ ] Sealing externo **obrigatório** (`required: true`)
- [ ] Manifest signing exigido pra MCP
- [ ] Audit log retenção alinhada com compliance (≥ 7 anos comum)
- [ ] Red team report independente
- [ ] Política de incident response documentada
