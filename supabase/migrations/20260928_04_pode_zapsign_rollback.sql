-- Rollback de 20260928_04_pode_zapsign.sql — definição da trava como estava em prod (28/09/2026).
-- Antes de rodar: reverter api/zapsign.js (sem a coluna o proxy nega todo envio de colaborador — fail-closed).
create or replace function public.enforce_app_users_privilege_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
$function$;

alter table public.app_users drop column if exists pode_zapsign;
