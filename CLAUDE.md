# CLAUDE.md — cobrasq-faturamento

## Idioma
Responder **sempre em português (Brasil)**.

## Fluxo de trabalho (LEIA ANTES DE EDITAR)
- O checkout local costuma estar **atrás de origin/main** e há **vários worktrees/sessões
  simultâneos** neste repo. Sempre `git fetch origin` e trabalhe em **branch/worktree novo
  a partir de `origin/main`**; commite cedo para não conflitar com outra sessão.
- **Deploy = merge do PR na main** (Vercel publica automaticamente). Merge de PR e
  migração em produção são **gated**: nunca rodar `gh pr merge` nem aplicar migração em
  prod sem autorização explícita do usuário. Commit, push e abrir PR são permitidos.
- Após migração de **dados**, uma aba antiga do painel ainda aberta **regrava os valores
  antigos** — sempre pedir para recarregar o painel depois.

## Arquitetura (visão geral)
App único servido pela Vercel, sobre o projeto Supabase compartilhado
`jokbxzhcctcwnbhkhgru`:

- **`index.html`** — app Faturamento (SPA principal).
- **`crm.html`** — CRM, servido em **`/crm`** (rota definida em `vercel.json`). Antes era
  um repositório separado (`crm-cobrasq`); foi mesclado para cá em 2026-06.
- **`calc-juridica.html`** — calculadora jurídica (embutida via iframe pelo CRM).
- **`api/`** — funções serverless Vercel (SSO, MFA, Asaas, Z-API, ZapSign, Claude, cron).
- **`supabase/`** — fonte única de `migrations/`, `functions/` (edge) e `verification/`.

## Vercel — limite de 12 funções (plano Hobby)
Máximo de **12 Serverless Functions** em `api/`. Função nova entra como arquivo com
prefixo `_` (ex.: `api/_minha-funcao.js`, não conta no limite) exposta como **ação dentro
de `api/automacao.js`**. Se estourar o limite, o build **falha com o erro escondido no
meio dos warnings** — só visível logado no painel da Vercel.

## Sessão / login (mesma origem)
`index.html` e `crm.html` rodam na **mesma origem**, então compartilham `localStorage` e,
por consequência, a **sessão do Supabase** (ambos usam a `storageKey` **default** — o CRM
teve a `crm-cobrasq-auth` removida no merge). Não é preciso `sso_token` entre eles.
`api/sso.js` permanece como fallback de infraestrutura.

## Banco de dados — regras importantes
- Migrações em `supabase/migrations/` **já estão aplicadas em produção**. **NÃO** rodar
  `supabase db push` cegamente. Ver `supabase/migrations/0000_MERGE_CRM_baseline.md`.
- A view `casos`/`view_casos` é **fonte única aqui**. Toda redefinição deve re-declarar
  `WITH (security_invoker = true)` (guarda anti-drift F-04 — ver
  `supabase/migrations/README.md`).
- `cobrancas.fora_crm=true` tira o caso da view `casos` (não é arquivamento nem
  encerramento, ver comentário da coluna). Lido em produção por `bia-atendimento`,
  `beatriz-msg` e `peticao-assistente` via `.from('casos')` — um `fora_crm` indevido faz
  a Bia responder ao credor "não encontrei esse caso" mesmo ele existindo, ou bloqueia
  (403) petição/sugestão de resposta pra aquele caso. Só marcar quando bater com o
  critério da coluna (judicial protocolado, acordo assinado, concluído, acordo firmado
  fora) — achado em 18/09/2026 (caso "Paulo Cesar de Souza Valente" estava com `fora_crm`
  sem nenhum desses motivos; corrigido).
- Edge functions já implantadas; não redeployar sem necessidade.

## Dual-write blob + relacional (armadilha nº 1)
O app ainda **lê o blob** (`DB.*`) e escreve **blob + tabelas relacionais**. Consequências:
- **Dono do caso vive em dois lugares**: `assigned_to` (relacional, UUID) e nome no
  blob/metadata. Transferência tem que sincronizar **ambos** — usar
  `scripts/transferir-responsavel.sql`.
- `devedores` e `cobrancas` compartilham o **mesmo id** só nos casos legado (1:1). O
  caminho atual e correto pra achar o devedor de uma cobrança é `cobrancas.id →
  cobranca_partes.cobranca_id (principal=true) → devedores.id` — é o que a própria view
  `casos` usa, e sustenta múltiplos devedores/corresponsáveis por cobrança. Join direto
  por id sem passar por `cobranca_partes` já deixou ~5 de 86 casos de fora numa consulta
  (18/09/2026). A view `casos` é a fonte única do CRM.
- Import só relacional **não aparece no portal do cedente** (que lê `DB.devedores` do
  blob) sem backfill no blob.
- Rascunhos: `metadata.isDraft` existe em `devedores` **e** `cobrancas`; a coluna
  `is_draft` precisa ser escrita junto (histórico de "rascunho-fantasma" que ressuscitava).

## Trigger F-20 (anti-shrink) — só existe em PROD
A mensagem **"🛡️ F-20: gravação bloqueada"** vem de um **trigger criado direto em
produção** — ele **não está** em `supabase/migrations/`. Armadilhas conhecidas:
- Colaborador (RLS) carrega o blob completo mas o relacional filtrado → a contagem cai →
  F-20 bloqueia o save dele.
- `_DEV_COL_FIELDS` referenciando coluna inexistente já **zerou** o campo `responsavel`.

## RLS / perfis
4 perfis reais: **proprietário/gestor, colaborador, cedente (empresa cliente), devedor**.
- Cedente **não** lê a própria linha de `clientes` via RLS (a política usa `app_user_id`,
  que nunca é populado); o vínculo real é `app_users.ref_id → clientes.id` e a leitura se
  faz pelas **RPCs security-definer** `cedente_meu_cliente()` / `cedente_set_logo()`.
- Ao validar qualquer mudança, **simular os 4 perfis** (protocolo completo na skill
  `/auditar-cobrasq`).

## Integrações
- **Controlle**: `fin_*` é espelho (sync: `import_controlle.py` full +
  `api/cron-controlle.js` às 06h UTC). Pegadinhas: valores em **centavos**; agendados
  exigem `END_DATE` futuro; a API não tem "modificado-desde". Saldos: `balance` = livro,
  `bank_balance` = conciliação bancária, `initial_amount` = abertura.
- **Asaas**: pagamento só vira `fin_operacao` se o devedor tem `asaas_customer_id`
  (backfill owner-only em `/api/backfill-asaas-customers?dry=1`, casa por CPF — repetir
  após importar devedores).
- **Corrente do acordo**: assinatura ZapSign → boleto Asaas → aviso Z-API
  (`AUTO_EMIT_ACORDO` **ligado**).
- **NFS-e**: emitida no **ESNFS** (prefeitura de Dois Vizinhos) pela extensão do Chrome
  em `extensao/esnfs/`, com ponte por área de transferência (`assets/js/esnfs-ponte.js`).
  A fila de Emitir NF nasce dos **lançamentos de entrada pagos com cobrança**
  (`fin_lancamento` tipo 1/status 1/`cobranca_id`, desde 03/07/2026); o **tomador é o
  devedor da cobrança**, nunca o cliente Asaas (quem pagou). `nf_fila_analise` é só a
  decisão (chave `asaas_payment_id` ou `lanc:<id>`), criada ao decidir.
  Emitir NF → "Copiar lote p/ ESNFS" (base = honorário quando há capital do credor) →
  extensão emite → "Importar resultado" grava em `nf_avulsa` (metadata.origem `esnfs`,
  `nf_number`, `emitida_em`) e marca fila/`fin_operacao`. A rota pelo Asaas
  (`api/_emitir-nf*.js`) **nunca emitiu em produção** e saiu da tela em 13/09/2026 —
  código mantido, sem botão. Relatório: Financeiro → **Faturamento** (previsão do
  Simples = faturamento × `DB.config.simplesAliquotaEfetiva`; "Lançar DAS" cria a saída
  na categoria "Simples Nacional - DAS", vencimento dia 20 do mês seguinte).

## CRM — estado client-side (atenção em mudanças de origem)
O CRM usa chaves de `localStorage` (`cobrasq_checklist_tel_*` é só local, sem backing no
banco; `cobrasq_falhas_pendentes` e `crm_envios_falhados_local` são fallbacks das tabelas
`falhas_reportadas`/`crm_envios_falhados`). Mudança de domínio descarta essas chaves —
sincronizar/migrar antes de qualquer cutover de origem.

## Outras armadilhas conhecidas
- Um `*/` dentro de **comentário CSS** no `index.html` já quebrou o app inteiro — cuidado
  ao comentar blocos grandes.
- Em material **público** da COBRASQ, posicionar sempre como cobrança
  **extrajudicial**/recuperação de crédito — nunca anunciar atuação judicial (privativa
  de advocacia; fica no Teixeira & Azzolin).
- Catálogo de regressões com prova: `docs/audit/REGRESSOES.md`. Queries de verificação:
  `supabase/verification/`. Auditoria ponta a ponta: skill `/auditar-cobrasq`.
