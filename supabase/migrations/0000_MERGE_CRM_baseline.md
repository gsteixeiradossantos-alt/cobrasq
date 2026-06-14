# Baseline do merge CRM → Faturamento (2026-06-14)

As migrações com prefixo de data **`2026-05-1x_` / `2026-06-1x_`** (padrão com hífens)
vieram do repositório **`crm-cobrasq`** durante o merge do CRM para dentro deste app.

## ⚠️ JÁ ESTÃO APLICADAS EM PRODUÇÃO — NÃO RE-EXECUTAR
Os dois apps sempre usaram o **mesmo** projeto Supabase (`jokbxzhcctcwnbhkhgru`).
Essas migrações já foram aplicadas pelo CRM antes do merge. Trazê-las para cá é
**reconciliação de fonte (documental)**: passa a existir uma única fonte de verdade do
schema. **Não rodar `supabase db push` cegamente** contra produção — re-aplicar poderia
falhar ou redefinir objetos e afetar dados/status existentes.

Para um ambiente novo (do zero), aplicar respeitando a ordem cronológica combinada dos
dois conjuntos de nomes (`20260510_01_...` e `2026-05-1x_...`).

## Fonte única da view `casos` / `view_casos` (guarda F-04)
Ver `README.md` ("Guarda anti-drift da view `casos`"). Antes do merge, ambos os repos
redefiniam essa view. A definição **vigente** no banco é a do arquivo de data mais
recente que a toca — atualmente:

- `2026-06-11b_fix_view_casos_casts_seguros.sql` (CRM, 2026-06-11) — **mais recente**
- `20260610_02_casos_security_invoker.sql` (Faturamento, 2026-06-10)

**Regra a partir de agora:** toda alteração de `casos`/`view_casos` é feita **somente
neste repositório**, sempre re-declarando `WITH (security_invoker = true)`.

### Verificação obrigatória na validação (Fase 2, read-only)
Capturar `pg_get_viewdef('public.casos')` em produção (via Supabase MCP) e confirmar que
bate com a última migração acima; rodar o smoke test `../verification/lote0_verify.sql`
(F-04: sem vazamento cross-tenant).

## Edge functions trazidas do CRM
`beatriz-msg`, `cron-mensagens-agendadas`, `enviar-whatsapp`, `gsheet-acordo`,
`peticao-assistente`, `zapi-webhook`, `zapsign-webhook` — **já implantadas** no projeto
Supabase compartilhado. Código trazido como fonte única; **não redeployar** sem
necessidade (rodam com os secrets atuais do projeto). Há sobreposição conceitual com a
camada `api/` (Z-API: `api/zapi.js`; ZapSign: `api/zapsign.js`) — são camadas distintas
(serverless Vercel vs edge Supabase); manter ambas e documentar.
