-- Rollback de 20260926_04 (investigação avulsa).
-- Só volta devedor_id a obrigatório se não houver avulsa gravada: apagar ou
-- vincular antes (a linha abaixo falha enquanto existir devedor_id null).
-- select count(*) from public.investigacoes_patrimoniais where devedor_id is null;

drop policy if exists investigacoes_patrimoniais_staff_select on public.investigacoes_patrimoniais;
create policy investigacoes_patrimoniais_staff_select on public.investigacoes_patrimoniais for select to authenticated using (
  current_user_papel()='proprietario' or (current_user_papel()='colaborador' and exists (select 1 from public.devedores d where d.id=devedor_id and (d.cadastrado_por=auth.uid() or d.assigned_to=auth.uid())))
);
alter table public.investigacoes_patrimoniais alter column devedor_id set not null;
-- Em seguida reaplicar o bloco "create or replace function
-- public.iniciar_investigacao_patrimonial" + revoke/grant de
-- supabase/migrations/20260926_03_investigacao_cobranca_escolhida.sql.
