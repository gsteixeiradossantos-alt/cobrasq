-- ✅ APLICADA EM PRODUÇÃO 2026-07-06 (via MCP, projeto jokbxzhcctcwnbhkhgru). Não reaplicar.
-- ============================================================================
-- ESCALAÇÃO DE PRIVILÉGIO em app_users (descoberta ao revisar a trava de
-- valor_capital — a trava depende de app_users.papel, então este é o elo real).
--
-- Buraco: a RLS `users_update_self_or_owner` (UPDATE, authenticated) tem
--   USING ((id = auth.uid()) OR current_user_papel() = 'proprietario')
-- e NÃO tem WITH CHECK; UPDATE é concedido a authenticated. Como a RLS não compara
-- NEW vs OLD, um colaborador podia:
--   (a) PATCH /rest/v1/app_users?id=eq.<self> {papel:'proprietario'}  → virar admin;
--   (b) PATCH ... {pode_ver_grupo:true, grupo_economico_id:'<alvo>'}  → enxergar
--       clientes/devedores de qualquer grupo econômico (RLS de clientes/devedores usa
--       current_user_grupo()/current_user_grupo_economico(), que leem essas colunas).
-- Havia ainda um 2º vetor: a view `profiles` (INSTEAD OF UPDATE, SECURITY DEFINER,
-- owner postgres) mapeia role='admin'→papel='proprietario' e bypassa a RLS.
--
-- Correção (trigger de TABELA, cobre AMBOS os vetores — o PATCH direto e a view
-- profiles, porque auth.role()/auth.uid() não são resetados no SECURITY DEFINER
-- aninhado): bloqueia mudança de papel/ativo/pode_ver_grupo/grupo_economico_id/
-- cliente_grupo_id por CLIENTE (authenticated/anon) que não é proprietário. Isenta
-- service_role e contextos sem JWT (backend/cron). Não impede o usuário de editar
-- nome/email/avatar da própria linha.
--
-- Revisada adversarialmente por agente (que descobriu o vetor da view profiles E a
-- extensão para as colunas de grupo) e PROVADA em produção: colaborador tentando
-- papel='proprietario' + grupo foi bloqueado (42501), sem persistir nada.
--
-- Defesa em profundidade (opcional, fora desta migração): adicionar WITH CHECK à
-- policy users_update_self_or_owner e/ou revogar UPDATE de colunas sensíveis de
-- authenticated. Obs.: WITH CHECK sozinho NÃO fecha a view profiles (bypassa RLS) —
-- por isso a trava é de trigger.
-- ============================================================================

create or replace function public.enforce_app_users_privilege_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE'
     and ( NEW.papel is distinct from OLD.papel
        or NEW.ativo is distinct from OLD.ativo
        or NEW.pode_ver_grupo is distinct from OLD.pode_ver_grupo
        or NEW.grupo_economico_id is distinct from OLD.grupo_economico_id
        or NEW.cliente_grupo_id is distinct from OLD.cliente_grupo_id )
     and auth.role() in ('authenticated','anon')
     and coalesce(public.current_user_papel(), '') <> 'proprietario' then
    raise exception 'Somente o proprietário pode alterar papel/ativo/grupo de um usuário.'
      using errcode = '42501';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_app_users_privilege_lock on public.app_users;
create trigger trg_enforce_app_users_privilege_lock
before update on public.app_users
for each row execute function public.enforce_app_users_privilege_lock();

-- Rollback:
--   drop trigger if exists trg_enforce_app_users_privilege_lock on public.app_users;
--   drop function if exists public.enforce_app_users_privilege_lock();
