# Catálogo de Regressões — cobrasq-faturamento

Lista FIXA das falhas que se repetem neste sistema. A skill `/auditar-cobrasq` roda este catálogo a cada
vistoria; cada item tem um **teste concreto** (SQL via Supabase MCP no projeto `jokbxzhcctcwnbhkhgru`, `grep`
no código, ou ação na UI) e o **estado-correto** esperado. Atualize ao descobrir uma nova classe.

> Convenção: **R-NN** = regressão; **F-NN** = invariante guardada (testes em `test/f0*.js` + `CLAUDE.md`).
> "Última checagem" registra o que a auditoria viu — reconferir sempre, não confiar na data.

---

## R-01 · Divergência blob × relacional (a causa nº 1)
- **O que é:** dados vivem no blob `cobrasq_data` (key `'main'`, `data.devedores/clientes`) E no relacional
  (`devedores`/`cobrancas`/`clientes`). Se um leitor ainda lê do blob, ele mostra número/ड़ono/dívida defasados.
- **Onde:** `index.html` (`loadFromSupabase`, `loadRelationalData`, `flushRelational`); tabela `cobrasq_data`.
- **Teste:** `auditoria_dados_perfis.sql §1` — comparar `jsonb_array_length(data->'devedores')` (blob) com
  `count(*)` relacional; `grep -n "DB.devedores\|cobrasq_data\|data->'devedores'" index.html` p/ achar leitores.
- **Estado-correto:** relacional é a fonte; blob congelado (Fase 3 #158). Nenhuma TELA decide por contagem do blob.
- **Perfil exposto:** colaborador e gestor. **Verificado 2026-06-27:** a divergência (blob 60 / relacional 66)
  é **DADO MORTO** — no login `loadRelationalData` sobrescreve `DB.devedores/clientes` com o relacional e
  rebaseia o F-20; o blob só é fallback ("modo seguro", não grava). **Mitigado.** **Landmine fechado:** o
  `SELECT using(true)` do blob virou **staff-only** em `20260627_sec_audit_p2.sql` (antes do portal
  cedente/devedor, que poderia ler os 60/105 congelados via API). Faxina final (tirar devedores/clientes do
  blob de vez) = baixa prioridade.

## R-02 · F-20 falso-positivo bloqueia save do colaborador
- **O que é:** no login o blob carrega N (todos) e seta `_lastKnownDevCount`; depois `loadRelationalData`
  reduz para o subconjunto RLS do colaborador. Se o baseline não for rebaixado, o 1º save vê `localDevs <
  _lastKnownDevCount-2` e BLOQUEIA ("🛡️ Salvamento bloqueado").
- **Onde:** `index.html` ~4183 (trava) e fim de `loadRelationalData` ~4717-4723 (rebase, fix #142).
- **Teste:** `auditoria_dados_perfis.sql §2` (quanto cada colaborador enxerga vs blob); `grep -n
  "_lastKnownDevCount" index.html` e confirmar o rebase ao FIM de `loadRelationalData`.
- **Estado-correto:** baseline = subconjunto real do usuário (rebase presente). Trigger `trg_cobrasq_data_anti_shrink` em prod protege o blob no servidor.
- **Perfil exposto:** colaborador. **Última checagem:** Natália vê 43, blob 60, gestor 66; rebase #142 presente no código → mitigado. "GT Conexões" vê 0 (atenção se logar).

## R-03 · Rascunho-fantasma (caso some e volta)
- **O que é:** o carimbo de rascunho precisa viver na COLUNA `is_draft` (em `devedores` E `cobrancas`), não só
  no `metadata`; senão ressuscita na carga e/ou some do CRM.
- **Onde:** `devedores.is_draft`, `cobrancas.is_draft`, `clientes.is_draft`; view `casos` (`... and not is_draft`).
- **Teste:** `auditoria_dados_perfis.sql §3` (contagem de `is_draft`; rascunhos antigos); conferir que a view
  `casos` exclui draft e mantém `security_invoker=true`.
- **Estado-correto:** `is_draft` na coluna; view exclui; índice de CPF exclui rascunho.
- **Perfil exposto:** colaborador (cadastra e "some"). **Última checagem:** dev_draft=1, cob_draft=3, cli_draft=0.

## R-04 · "O conserto ficou em PR aberto" (nunca foi pro ar)
- **O que é:** o fix existe em branch/PR mas NÃO foi mergeado em `main` → não está no ar (deploy = merge).
- **Teste:** `gh pr list --repo gsteixeiradossantos-alt/cobrasq-faturamento --state open` e cruzar com a
  mudança pedida; `git -C <repo> fetch` + `git log origin/main` p/ ver se o commit está em `main`.
- **Estado-correto:** mudança prometida = commit em `origin/main`. **Última checagem:** abertos relevantes
  fora do ar — **#59** (registrar pagamento → "Recuperado no mês"), **#91** (validar resposta real do Z-API,
  parar falso "enviada"), #29 (cálculo cadastro), #9 (Cache-Control no-store).

## R-05 · Limite de 12 funções da Vercel (build quebra silencioso)
- **O que é:** Hobby permite só 12 Serverless Functions. Função `.js` nova na raiz de `api/` (sem `_`) estoura
  o limite e o build falha — com o erro real escondido entre warnings.
- **Teste:** `auditoria_deploy.sql`/shell: `ls api/*.js | grep -v '^_'` deve dar ≤12; função nova deve entrar
  como ação em `automacao.js` + rewrite em `vercel.json`.
- **Estado-correto:** ≤12 reais; o resto via `_arquivo.js` + dispatcher. **Última checagem:** 12/12 (no limite).

## R-06 · Trigger/esquema em prod fora das migrations (drift)
- **O que é:** objeto em produção (trigger, índice, policy) que não está nas migrations versionadas → o que
  está no código diverge do que roda.
- **Teste:** `auditoria_deploy.sql` (lista triggers/policies de prod) cruzado com `supabase/migrations/`.
- **Estado-correto:** todo objeto de prod tem migration correspondente. **Última checagem:** triggers de prod
  (`trg_cobrasq_data_anti_shrink`, `devedores_preserve_asaas`, `*_set_cadastrado_por`, `trg_calendar_orphans_devedores`)
  têm migration; view `casos` `security_invoker=true` ✓.

## R-07 · Tabelas de backup/arquivo expostas (vazamento de PII) ⚠️ P0
- **O que é:** tabelas `_backup_*`/`_arquivo_*` (cópias de devedores/cobranças/blob com nome, CPF, dívida)
  ficam no schema `public` SEM RLS e com GRANT para `anon`/`authenticated` → qualquer um com a chave anon
  (pública no `index.html`) lê via PostgREST `/rest/v1/_backup_...`.
- **Teste:** `auditoria_seguranca.sql §1` + `get_advisors(security)` (lints `rls_disabled_in_public`).
- **Estado-correto:** backups fora do schema exposto, ou RLS deny-all, ou `revoke ... from anon, authenticated`,
  ou dropados após uso.
- **Perfil exposto:** TODOS (inclusive anon). **RESOLVIDO 2026-06-26:** (a) as 14 tabelas `_backup_*`/
  `_arquivo_*` tiveram RLS ligada pelo **PR #164** (`20260626_lock_backup_tables_pii.sql`); (b) a view
  **`profiles`** (expunha e-mail da equipe a logado não-staff) ganhou guard de staff em
  `20260626_sec_audit_p1.sql` → não-staff recebe 0 linhas (verificado). **Residual (por design):** advisor
  ainda marca `profiles` como `security_definer_view`/`auth_users_exposed` (precisa de auth.users p/ o e-mail
  da equipe e do trigger INSTEAD OF p/ o CRM gerir usuários); exposição real fechada. 2 backups ainda com
  grant residual (inócuo sob RLS) — revogados em `20260626_sec_audit_p1.sql`.

## R-08 · Pagamentos não viram fin_operacao (corrente parada)
- **O que é:** recebimento só alimenta o financeiro (`fin_operacao`/"Recuperado no mês") se o devedor tem
  `asaas_customer_id`; e o fluxo "Registrar pagamento" depende do PR #59 (aberto).
- **Onde:** `api/_processar-recebimento.js`, `api/_backfill-asaas-customers.js`, trigger `devedores_preserve_asaas`.
- **Teste:** `auditoria_dados_perfis.sql §4` (devedores sem `asaas_customer_id`); `fin_operacao` recente.
- **Estado-correto:** devedores com boleto têm `asaas_customer_id`; pagamento gera `fin_operacao`.
- **Perfil exposto:** gestor (painel). **Última checagem:** PR #59 ABERTO (fluxo de registro incompleto no ar).

## R-09 · Corrente acordo → boleto (num_parcelas nulo / reflexo no CRM)
- **O que é:** acordo assinado (ZapSign) deve emitir N boletos (Asaas) e refletir no CRM; bugs conhecidos:
  `num_parcelas` nulo gerava 1 boleto (fix #155 → `acordo_final`), e webhook não refletia no CRM (fix #156).
- **Teste:** conferir `api/_emitir-acordo.js` (fallback `acordo_final`) e `api/zapsign.js` (reflete em `cobrancas`,
  conclui `encerramento.tipo='acordo'`, vincula `cobranca_id`).
- **Estado-correto:** #155 e #156 mergeados. **Última checagem:** #155/#156 MERGED ✓ — reconferir se regrediu.

## R-10 · Z-API: falso "enviada" (mensagem não chega)
- **O que é:** o envio marca "enviada" sem validar a resposta real do Z-API → boleto/régua que o devedor nunca
  recebeu aparecem como enviados. Fix no PR #91 (DRAFT, fora do ar).
- **Onde:** `api/_zapi.js`, `api/cron-regua.js`.
- **Teste:** `grep` por checagem de status real na resposta do Z-API; PR #91 mergeado?
- **Estado-correto:** envio só vira "enviada" com confirmação do Z-API. **Última checagem:** #91 DRAFT — ABERTO.

## R-11 · Calculadora: matriz única vs. filiais que voltam a divergir
- **O que é:** correção/juros/multa/honorários têm **UMA matriz** — `templates/calc-engine.js`
  (`CalcEngine.juridica / cobranca / correcaoMensal` + tabelas de índice). As telas são **filiais finas que só
  CHAMAM**. Toda fórmula **ou tabela de índice copiada** numa tela volta a divergir (atualiza numa, esquece na
  outra → a MESMA dívida dá total diferente conforme a aba/fluxo). Foi exatamente a origem do #180 (3 motores +
  ~13 tabelas hardcoded, já divergentes).
- **Onde:** matriz `templates/calc-engine.js` (carregada por `<script src="/templates/calc-engine.js">` em
  `index.html` e `crm.html`). Filiais: `index.html` (`calcDividaCobranca`, `_petCalcJuridica`, `petComputeCalc`,
  **`calcDividaAtualizada` + `CALC_INPC_MENSAL`**), `crm.html` (`_calcCobrancaSimples`, `_calcJuridicaMemorial`,
  `_pecaAplicarCorrecaoMensal`), `calc-juridica.html` (standalone, iframe no CRM).
- **Teste:**
  - `grep -nE "CalcEngine\.(juridica|cobranca|correcaoMensal)" index.html crm.html` → toda peça/cobrança/memorial
    deve passar por aqui; **nenhum motor reimplementado inline**.
  - `for f in index.html crm.html calc-juridica.html templates/calc-engine.js; do echo -n "$f "; grep -oc "'2024-06'" $f; done`
    (conta tabelas mensais por arquivo). **Esperado hoje:** `templates/calc-engine.js`=4 · `crm.html`=0 ·
    **`index.html`=1 (PENDENTE — `CALC_INPC_MENSAL`)** · `calc-juridica.html`=4 (standalone, fase 2). **Meta:**
    `index.html`=0; idealmente só a matriz tem tabela.
  - **Paridade de inputs da cobrança:** `calcDividaCobranca` (index — taxas de `getCalcParams()`→`DB.config`) e
    `_calcCobrancaSimples` (crm — constantes `TAXA_*`) precisam mandar os MESMOS números **e o mesmo `meses`**
    (index usa `dias/30.4375`; crm usa `mesesEntre()`) para `CalcEngine.cobranca` — senão divergem assim que o
    gestor editar os parâmetros em `DB.config`.
- **Estado-correto:** uma matriz; **nenhuma 2ª cópia** de tabela de índice; índice e taxas vêm de uma fonte só.
- **Pendências (faxina do #180 — "Fase B/2"):**
  1. **`calcDividaAtualizada` + `CALC_INPC_MENSAL`** (execução/Sisbajud "valor atualizado", INPC composta +
     garantia STJ) → migrar para `CalcEngine.correcaoMensal` e **apagar a 2ª tabela INPC do `index.html`** (a que
     vai driftar todo mês). **Mais urgente** — é a única tabela duplicada que sobrou.
  2. **Paridade cobrança admin × CRM** — unificar a fonte das taxas (`DB.config` × constantes) e a convenção de
     `meses`, senão a mesma dívida diverge entre o painel e o CRM quando o gestor mexer nos parâmetros.
  3. **`calc-juridica.html` standalone na matriz** — decidir como levar a série histórica (~566 meses; a matriz
     só tem ~24). Versão portátil entregue **fora do repo** em `~/Desktop/Cloude/Calculadora-Juridica-COBRASQ.html`
     (CSS embutido, Supabase removido — abre offline; histórico desativado).
- **Última checagem 2026-06-28:** #180 (`3e32e6a`) **no ar** — jurídica + cobrança + correção de index/crm já na
  matriz; `crm.html` zerou suas tabelas; `petComputeCalc` (Bia multi-linha) usa `_petCalcJuridica`→matriz por
  linha (honorários sobre o subtotal agregado = decisão, não duplicação). `/templates/calc-engine.js` servido em
  prod como `application/javascript` (200). **Faltam os itens 1–3.**

---

### Invariantes guardadas (não quebrar)
- **F-04** view `casos`/`view_casos` SEMPRE `WITH (security_invoker = true)`.
- **F-20** trigger anti-encolhimento do blob + rebase do baseline no cliente.
- **F-22** (em desenvolvimento) colaborador cadastra credor via **aprovação do gestor** (branches
  `feat/aviso-aprovacao-whatsapp`, `feat/editar-credor-aprovacao`).
- Higiene git: **fetch+rebase antes de afirmar/pushar**; editar em worktree isolado (sessões concorrentes).
- Posicionamento público COBRASQ = **extrajudicial** (o judicial é do escritório Teixeira & Azzolin).

---

### Pendências de evolução (não-regressão — rever a cada vistoria)
Itens de roadmap acordados mas ainda **não construídos**. Não são bugs; servem para a auditoria
lembrar o Gustavo e, se já tiverem virado código, conferir a migração/RLS correspondente.

- **P-01 · Rastreamento por caso da sequência de diligências (Opção C).** Hoje a Bia gera o
  requerimento de diligências por um **checklist tático** (Opção A, #181): o operador marca o que
  requerer e o que "já tentou (negativa)" — esse estado **não é persistido**. A Opção C guardaria,
  por execução, em que passo da ordem-padrão cada caso está (ex.: Sisbajud feita 12/06 negativa →
  próxima é Renajud) e **sugeriria a próxima diligência automaticamente** na lista de execuções.
  **Por que está parado:** exige **migração** (tabela/coluna nova p/ o histórico de diligências por
  caso) — o modelo de dados ainda será decidido com o Gustavo.
  **O que a auditoria deve fazer:** (a) perguntar se é hora de construir; (b) se já foi construído,
  confirmar que a **migração está aplicada em prod** (não só em PR — ver R-04) e que a tabela nova
  tem **RLS** ligada (mesma classe do R-07, para não vazar PII de execução). Base já no ar: modo
  intercorrente (#169) + catálogo `DILIG_MEDIDAS`/checklist de diligências (#181) em `index.html`.
