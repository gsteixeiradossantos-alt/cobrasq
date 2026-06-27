-- Auditoria de segurança P2 — fecha landmine do blob + revoga funções internas (2026-06-27)
-- Complementa 20260626_sec_audit_p1.sql. Achados da skill /auditar-cobrasq. Reversível: ver _rollback.
begin;

-- P0 LATENTE · cobrasq_data: SELECT deixa de ser using(true). Hoje só há logins staff (1 proprietário
-- + 4 colaboradores; ZERO cedente/devedor), então ninguém perde acesso. Fecha a leitura do blob
-- (60 devedores + 105 clientes CONGELADOS) ANTES de existir login de cedente/devedor (portal F-22).
-- anon já era bloqueado (tem grant mas nenhuma policy → RLS nega).
drop policy if exists data_read_all_authed on public.cobrasq_data;
create policy data_read_staff on public.cobrasq_data
  for select to authenticated
  using (current_user_papel() = any (array['proprietario','colaborador']));

-- P2 · funções internas que são SÓ trigger/manutenção (verificado: não são DEFAULT de coluna nem
-- usadas em policy): revoga EXECUTE público. Triggers disparam sem EXECUTE do chamador; manutenção
-- roda via service role. NÃO mexo em current_user_papel()/current_user_grupo*() — essas são usadas
-- em policies RLS e revogar quebraria o acesso do cedente.
revoke execute on function public.fn_default_cadastrado_por()         from public, anon, authenticated;
revoke execute on function public.fn_sync_app_user_to_auth_metadata() from public, anon, authenticated;
revoke execute on function public.limpar_portal_tokens_vencidos()     from public, anon, authenticated;

commit;
