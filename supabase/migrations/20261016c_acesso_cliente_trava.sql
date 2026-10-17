-- 20261016c — Trava de acesso: arquivos do peticao-assets e login desativado.
--
-- 1) peticao-assets: a policy de leitura liberava o bucket a QUALQUER login
--    (auth.uid() is not null). Um cedente ou devedor logado baixava, pela API, os
--    113 objetos — contratos assinados de clientes (clientes/<id>/assinado_*.pdf),
--    provas de casos e notas fiscais de devedores. Nenhuma tela de cliente ou de
--    devedor lê esse bucket (só o cadastro de clientes e o envio de relatórios, da
--    equipe). Leitura passa a ser: equipe, ou o dono da pasta (1ª pasta = uid),
--    o mesmo critério que insert/update/delete já usavam.
--
-- 2) Login desativado (app_users.ativo=false) continuava logando e lendo dados:
--    current_user_papel(), cedente_cliente_ids() e os helpers de grupo não
--    conferiam `ativo`. Caso real: Grupo TIC TAC, desativado sem registro de quem
--    nem quando, ainda lia 8 cobranças. Agora:
--      a) os helpers de papel/escopo devolvem vazio para login desativado
--         (corte imediato, inclusive com token ainda válido);
--      b) desativar bane a conta no Auth e derruba as sessões (não renova token);
--         reativar tira o banimento;
--      c) toda troca de `ativo` grava em audit_logs quem fez e quando, e
--         app_users.updated_at passa a acompanhar a alteração.
--
-- Rollback: 20261016c_acesso_cliente_trava_rollback.sql

begin;

-- ── 1) peticao-assets ──────────────────────────────────────────────────────
drop policy if exists peticao_assets_select on storage.objects;
create policy peticao_assets_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'peticao-assets'
    and (
      public.current_user_papel() in ('proprietario','colaborador')
      or (storage.foldername(name))[1] = (auth.uid())::text
    )
  );

-- ── 2a) helpers só respondem para login ativo ──────────────────────────────
create or replace function public.current_user_ativo()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((select coalesce(ativo, true) from public.app_users where id = auth.uid()), false);
$function$;

create or replace function public.current_user_papel()
 returns text
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  SELECT papel FROM public.app_users WHERE id = auth.uid() AND coalesce(ativo, true);
$function$;

create or replace function public.current_user_grupo()
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT cliente_grupo_id
  FROM public.app_users
  WHERE id = auth.uid()
    AND pode_ver_grupo = true
    AND coalesce(ativo, true)
$function$;

create or replace function public.current_user_grupo_economico()
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT grupo_economico_id FROM public.app_users WHERE id = auth.uid() AND pode_ver_grupo = true AND coalesce(ativo, true)
$function$;

create or replace function public.cedente_cliente_ids()
 returns setof uuid
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select cl.id from clientes cl where cl.app_user_id = auth.uid() and public.current_user_ativo()
  union
  select cl.id from clientes cl
   where current_user_grupo_economico() is not null
     and cl.grupo_economico_id = current_user_grupo_economico()
  union
  select cl.id from clientes cl
   where current_user_grupo() is not null
     and (cl.cliente_grupo_id = current_user_grupo() or cl.id = current_user_grupo())
$function$;

-- ── 2b/2c) desativar = banir no Auth + derrubar sessões + registrar ────────
create or replace function public.app_users_ativo_trava()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ator_nome text;
  v_ator_papel text;
begin
  if NEW.ativo is not distinct from OLD.ativo then
    return NEW;
  end if;

  NEW.updated_at := now();

  if coalesce(NEW.ativo, true) = false then
    update auth.users set banned_until = 'infinity' where id = NEW.id;
    delete from auth.sessions where user_id = NEW.id;
  else
    update auth.users set banned_until = null where id = NEW.id;
  end if;

  select nome, papel into v_ator_nome, v_ator_papel from public.app_users where id = auth.uid();
  insert into public.audit_logs (actor_id, actor_name, actor_role, action, entity, entity_id, metadata)
  values (
    auth.uid(),
    coalesce(v_ator_nome, case when auth.uid() is null then 'sistema/SQL' end),
    coalesce(v_ator_papel, auth.role()),
    case when coalesce(NEW.ativo, true) then 'Reativou usuário' else 'Desativou usuário' end,
    'app_users',
    NEW.id::text,
    jsonb_build_object('nome', NEW.nome, 'email', NEW.email, 'papel', NEW.papel,
                       'ativo_antes', OLD.ativo, 'ativo_depois', NEW.ativo)
  );
  return NEW;
end;
$function$;

drop trigger if exists trg_app_users_ativo_trava on public.app_users;
create trigger trg_app_users_ativo_trava
  before update of ativo on public.app_users
  for each row execute function public.app_users_ativo_trava();

-- Quem já está desativado hoje fica banido também (hoje: nenhum).
update auth.users a set banned_until = 'infinity'
  from public.app_users u
 where u.id = a.id and coalesce(u.ativo, true) = false;

commit;
