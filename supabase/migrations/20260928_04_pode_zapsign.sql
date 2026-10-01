-- ============================================================================
-- 20260928_04 — permissão de assinatura (ZapSign) por colaborador
-- NÃO APLICADA. Aditiva. Rollback: 20260928_04_pode_zapsign_rollback.sql
--
-- app_users.pode_zapsign (padrão false). O /api/zapsign só aceita método que não
-- seja leitura do proprietário ou do colaborador ativo com a flag; o painel esconde
-- os botões. A coluna entra na trava de privilégio (enforce_app_users_privilege_lock):
-- só o proprietário a altera — o colaborador não se autoconcede pela própria linha.
-- Definição anterior da função: ver o rollback.
-- ============================================================================

alter table public.app_users add column if not exists pode_zapsign boolean not null default false;

comment on column public.app_users.pode_zapsign is
  'Colaborador pode enviar documentos para assinatura (ZapSign). Só o proprietário altera. Conferido em api/zapsign.js.';

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
        or NEW.cliente_grupo_id is distinct from OLD.cliente_grupo_id
        or NEW.pode_zapsign is distinct from OLD.pode_zapsign )
     and auth.role() in ('authenticated','anon')
     and coalesce(public.current_user_papel(), '') <> 'proprietario' then
    raise exception 'Somente o proprietário pode alterar papel/ativo/grupo/assinatura de um usuário.'
      using errcode = '42501';
  end if;
  return NEW;
end;
$function$;
