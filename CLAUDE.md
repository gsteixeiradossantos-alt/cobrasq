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
- Edge functions já implantadas; não redeployar sem necessidade.

## Dual-write blob + relacional (armadilha nº 1)
O app ainda **lê o blob** (`DB.*`) e escreve **blob + tabelas relacionais**. Consequências:
- **Dono do caso vive em dois lugares**: `assigned_to` (relacional, UUID) e nome no
  blob/metadata. Transferência tem que sincronizar **ambos** — usar
  `scripts/transferir-responsavel.sql`.
- `devedores` e `cobrancas` compartilham o **mesmo id** (1:1); a view `casos` é a fonte
  única do CRM.
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
