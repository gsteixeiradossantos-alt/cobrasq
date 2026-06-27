-- Auditoria de segurança (P0/P1/P2) — achados da skill /auditar-cobrasq, 2026-06-26
-- Complemento do #164 (que trancou as tabelas _backup_*). Tudo reversível: ver _rollback.
-- Projeto: jokbxzhcctcwnbhkhgru. Não toca index.html/api.

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- P0 · View `profiles`: parar de vazar e-mail da equipe para logado não-staff.
-- A view continua SECURITY DEFINER (precisa ler auth.users p/ e-mail) e o trigger
-- INSTEAD OF UPDATE (trg_profiles_update) continua valendo. Só adicionamos um GUARD:
-- quem não for proprietario/colaborador recebe ZERO linhas (cedente/devedor não veem a equipe).
-- Mesmas colunas/ordem do original (CREATE OR REPLACE exige isso).
create or replace view public.profiles as
  select u.id,
         au.email::text as email,
         u.nome,
         case u.papel
           when 'proprietario' then 'admin'
           when 'colaborador'  then 'operador'
           else u.papel
         end as role,
         u.ativo,
         u.created_at,
         u.avatar_url,
         u.avatar_cor
  from app_users u
  left join auth.users au on au.id = u.id
  where u.papel = any (array['proprietario','colaborador'])
    and current_user_papel() = any (array['proprietario','colaborador']);  -- GUARD novo

-- ───────────────────────────────────────────────────────────────────────────
-- P1 · import_astrea: tirar o ALL using(true) (qualquer logado lê/escreve staging com PII).
drop policy if exists import_astrea_rw on public.import_astrea;
create policy import_astrea_staff on public.import_astrea
  for all to authenticated
  using      (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

-- ───────────────────────────────────────────────────────────────────────────
-- P2 · ag_actions / ag_conversations: UPDATE deixa de ser using(true) (um cedente/devedor
-- logado não pode mais alterar/aprovar ações do agente). SELECT mantido por ora.
drop policy if exists ag_actions_update_authenticated on public.ag_actions;
create policy ag_actions_update_staff on public.ag_actions
  for update to authenticated
  using      (current_user_papel() = any (array['proprietario','colaborador']))
  with check (status = any (array['pending_dispatch','approved','rejected','cancelled']::ag_action_status[]));

drop policy if exists ag_conv_update_authenticated on public.ag_conversations;
create policy ag_conv_update_staff on public.ag_conversations
  for update to authenticated
  using      (current_user_papel() = any (array['proprietario','colaborador']))
  with check (current_user_papel() = any (array['proprietario','colaborador']));

-- ───────────────────────────────────────────────────────────────────────────
-- P2 · Revogar EXECUTE do anon em funções internas (mantendo as do portal: portal_*).
revoke execute on function public.current_user_grupo_economico()      from anon;
revoke execute on function public.fn_default_cadastrado_por()         from anon;
revoke execute on function public.fn_sync_app_user_to_auth_metadata() from anon;
revoke execute on function public.limpar_portal_tokens_vencidos()     from anon;
-- NOTA: EXECUTE também é concedido via PUBLIC (anon herda), então estes REVOKE de anon são
-- PARCIAIS (o advisor ainda lista as funções). NÃO escalei para PUBLIC de propósito:
-- current_user_grupo_economico é usada em policies RLS do cedente e fn_default_cadastrado_por
-- alimenta cadastrado_por — revogar de PUBLIC poderia quebrar acesso/insert. São WARN de baixo
-- risco (não fazem nada útil/perigoso para anon). Tratar caso a caso depois, se quiser zerar.

-- ───────────────────────────────────────────────────────────────────────────
-- P2 · search_path fixo na função de trigger (lint function_search_path_mutable).
alter function public.preserve_asaas_customer_id() set search_path = public, pg_temp;

-- ───────────────────────────────────────────────────────────────────────────
-- Limpeza · grants residuais nas 2 backups que o #164 deixou (já bloqueadas por RLS,
-- mas removendo o grant por higiene).
revoke all on public._backup_cobrasq_data_20260611   from anon, authenticated;
revoke all on public._backup_devedores_divida_20260623 from anon, authenticated;

commit;
