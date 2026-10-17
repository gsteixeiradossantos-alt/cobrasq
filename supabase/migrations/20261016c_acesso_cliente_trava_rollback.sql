-- Rollback de 20261016c_acesso_cliente_trava.sql — volta exatamente ao estado anterior.
-- Atenção: devolve o vazamento do peticao-assets e o acesso de login desativado.
begin;

drop trigger if exists trg_app_users_ativo_trava on public.app_users;
drop function if exists public.app_users_ativo_trava();

drop policy if exists peticao_assets_select on storage.objects;
create policy peticao_assets_select on storage.objects
  for select to public
  using (bucket_id = 'peticao-assets' and auth.uid() is not null);

create or replace function public.current_user_papel()
 returns text language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  SELECT papel FROM public.app_users WHERE id = auth.uid();
$function$;

create or replace function public.current_user_grupo()
 returns uuid language sql stable security definer set search_path to 'public'
as $function$
  SELECT cliente_grupo_id
  FROM public.app_users
  WHERE id = auth.uid()
    AND pode_ver_grupo = true
$function$;

create or replace function public.current_user_grupo_economico()
 returns uuid language sql stable security definer set search_path to 'public'
as $function$
  SELECT grupo_economico_id FROM public.app_users WHERE id = auth.uid() AND pode_ver_grupo = true
$function$;

create or replace function public.cedente_cliente_ids()
 returns setof uuid language sql stable security definer set search_path to 'public', 'pg_temp'
as $function$
  select cl.id from clientes cl where cl.app_user_id = auth.uid()
  union
  select cl.id from clientes cl
   where current_user_grupo_economico() is not null
     and cl.grupo_economico_id = current_user_grupo_economico()
  union
  select cl.id from clientes cl
   where current_user_grupo() is not null
     and (cl.cliente_grupo_id = current_user_grupo() or cl.id = current_user_grupo())
$function$;

drop function if exists public.current_user_ativo();

-- Banimentos aplicados pela trava NÃO são desfeitos aqui (desbanir é decisão caso a caso):
--   update auth.users set banned_until = null where id = '<uid>';
commit;
