# CLAUDE.md — cobrasq-faturamento

## Idioma
Responder **sempre em português (Brasil)**.

## Arquitetura (visão geral)
App único servido pela Vercel, sobre o projeto Supabase compartilhado
`jokbxzhcctcwnbhkhgru`:

- **`index.html`** — app Faturamento (SPA principal).
- **`crm.html`** — CRM, servido em **`/crm`** (rota definida em `vercel.json`). Antes era
  um repositório separado (`crm-cobrasq`); foi mesclado para cá em 2026-06.
- **`calc-juridica.html`** — calculadora jurídica (embutida via iframe pelo CRM).
- **`api/`** — funções serverless Vercel (SSO, MFA, Asaas, Z-API, ZapSign, Claude, cron).
- **`supabase/`** — fonte única de `migrations/`, `functions/` (edge) e `verification/`.

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

## CRM — estado client-side (atenção em mudanças de origem)
O CRM usa chaves de `localStorage` (`cobrasq_checklist_tel_*` é só local, sem backing no
banco; `cobrasq_falhas_pendentes` e `crm_envios_falhados_local` são fallbacks das tabelas
`falhas_reportadas`/`crm_envios_falhados`). Mudança de domínio descarta essas chaves —
sincronizar/migrar antes de qualquer cutover de origem.
