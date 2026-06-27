-- Auditoria de segurança P3 — ag_actions/ag_conversations SELECT staff-only (2026-06-27)
-- Achado da skill /auditar-cobrasq. Mesmo landmine do blob: SELECT using(true) deixaria um login
-- cedente/devedor (quando o portal existir) ler as ações/conversas do "agente".
-- Verificado seguro: nenhum leitor em index.html/crm.html/api/edge functions; tabelas com 0 e 1 linha;
-- service-role ignora RLS. Reversível: ver _rollback.
begin;

drop policy if exists ag_actions_select_authenticated on public.ag_actions;
create policy ag_actions_select_staff on public.ag_actions
  for select to authenticated
  using (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists ag_conv_select_authenticated on public.ag_conversations;
create policy ag_conv_select_staff on public.ag_conversations
  for select to authenticated
  using (current_user_papel() = any (array['proprietario','colaborador']));

commit;
