-- ============================================================================
-- P0 · VIEWS SECURITY DEFINER ABERTAS AO `anon` (F-04)
--
-- APLICADA EM PRODUÇÃO em 29/07/2026, com autorização expressa do dono.
--
-- Achado pela auditoria (/auditar-cobrasq). Três views estão SECURITY DEFINER
-- (sem `security_invoker`) E com grant para `anon`. Como a view roda com os
-- privilégios do dono (`postgres`), ela passa por cima da RLS das tabelas de
-- baixo. Com a chave anon pública — a mesma que vai dentro do index.html e é
-- visível para qualquer um que abra o site — e SEM LOGIN:
--
--   GET /rest/v1/casos                    -> HTTP 206 · 145 registros
--   GET /rest/v1/vw_bia_respostas_humanas -> HTTP 206 · 329 registros
--   GET /rest/v1/vw_bia_metricas_semanal  -> HTTP 206 ·   4 registros
--
-- enquanto as tabelas por trás respondiam 401:
--
--   GET /rest/v1/cobrancas -> 401 · GET /rest/v1/devedores -> 401
--
-- `casos` expõe a carteira inteira (nome, CPF, dívida, telefone) e ainda tinha
-- INSERT/UPDATE/DELETE para anon, com 3 triggers INSTEAD OF ligados (escrita
-- não foi testada). `vw_bia_respostas_humanas` expõe conteúdo de conversa com
-- devedor.
--
-- Origem provável da regressão: `casos_view_add_carlos_ativo` (27/07/2026) —
-- redefinição da view que não re-declarou a option. É exatamente o histórico
-- que a guarda F-04 existe para impedir (ver supabase/migrations/README.md).
--
-- ── ESTE ARQUIVO É O PASSO 1 ────────────────────────────────────────────────
-- Tira só o `anon`. Nada legítimo usa anon nessas views: `casos` é lida pelo
-- crm.html com usuário autenticado (8 call sites; o index.html não a lê) e as
-- duas views da Bia não têm consumidor nenhum no código (grep vazio em
-- index.html, crm.html, api/ e supabase/functions/). `authenticated`,
-- `postgres` e `service_role` seguem intactos, então o CRM não sente.
--
-- ── PASSO 2 AINDA PENDENTE ──────────────────────────────────────────────────
--   alter view public.casos set (security_invoker = true);
-- Restaura a F-04 para quem ESTÁ logado. Hoje um colaborador que leia `casos`
-- ainda enxerga os 145 casos, não só os seus — o buraco anônimo fechou, o
-- cross-tenant entre logados não. Exige testar o CRM como colaborador e como
-- cedente antes, porque muda o que essas telas mostram.
-- ============================================================================

begin;

revoke all on public.casos                    from anon;
revoke all on public.vw_bia_respostas_humanas from anon;
revoke all on public.vw_bia_metricas_semanal  from anon;

commit;

-- ── VERIFICAÇÃO (o teste é externo, com a chave anon) ───────────────────────
-- for v in casos vw_bia_respostas_humanas vw_bia_metricas_semanal; do
--   curl -s -o /dev/null -w "$v -> HTTP %{http_code}\n" \
--     "https://jokbxzhcctcwnbhkhgru.supabase.co/rest/v1/$v?select=*&limit=1" \
--     -H "apikey: <ANON>" -H "Authorization: Bearer <ANON>"
-- done
-- Os três devem devolver 401. Resultado em 29/07/2026: 401, 401, 401.
--
-- Atenção ao ler outros 200: `clientes` e `acordos` devolvem HTTP 200 com
-- `content-range: */0` e corpo `[]`. Isso é o estado CERTO — o grant existe e a
-- RLS filtra tudo. 200 sozinho não é vazamento; o que importa é a contagem.

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- grant select, insert, update, delete on public.casos to anon;
-- grant select on public.vw_bia_respostas_humanas to anon;
-- grant select on public.vw_bia_metricas_semanal  to anon;
