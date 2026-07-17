-- ============================================================================
-- QuitaFácil — MAGIC-LINK do portal do devedor.
-- O link enviado (WhatsApp/e-mail/SMS) já abre o portal LOGADO: carrega um token
-- opaco (?qt=) que o servidor troca por uma sessão do portal — sem o devedor
-- digitar CPF+nascimento. Reduz o atrito e aumenta a conversão.
--
-- Segurança (espelha portal_meu_caso / portal_sessoes):
--  - O mint só é chamado server-side (service_role) pela régua.
--  - portal_login_magic (anon) valida o token e emite a MESMA sessão de posse
--    (_portal_emitir_sessao) que os outros logins do portal — daí em diante o
--    devedor só enxerga o próprio caso (portal_meu_caso / quita_oferta).
--  - Token expira (30 dias, cobre a cadência) e é reutilizável até expirar
--    (o devedor pode reabrir o mesmo link). Escopo = 1 devedor/1 cobrança.
--
-- ROLLBACK: drop function portal_login_magic(text); drop function portal_mint_magic(uuid,uuid,int); drop table portal_magic_tokens;
-- ============================================================================

create table if not exists public.portal_magic_tokens (
  token       text primary key,
  devedor_id  uuid not null references public.devedores(id) on delete cascade,
  cobranca_id uuid,
  criado_em   timestamptz not null default now(),
  expira_em   timestamptz not null,
  usado_em    timestamptz
);
create index if not exists idx_portal_magic_dev on public.portal_magic_tokens(devedor_id);
create index if not exists idx_portal_magic_exp on public.portal_magic_tokens(expira_em);

alter table public.portal_magic_tokens enable row level security;
-- Sem policy de propósito: só as funções SECURITY DEFINER abaixo tocam a tabela.

-- Mint (service_role only) — gera o token de acesso para um devedor+cobrança.
create or replace function public.portal_mint_magic(p_devedor_id uuid, p_cobranca_id uuid, p_dias int default 30)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_token text;
begin
  if p_devedor_id is null then return null; end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.portal_magic_tokens (token, devedor_id, cobranca_id, expira_em)
  values (v_token, p_devedor_id, p_cobranca_id, now() + (coalesce(p_dias, 30) || ' days')::interval);
  delete from public.portal_magic_tokens where expira_em < now() - interval '7 days';
  return v_token;
end;
$function$;

revoke all on function public.portal_mint_magic(uuid, uuid, int) from public;
grant execute on function public.portal_mint_magic(uuid, uuid, int) to service_role;

-- Login por magic-link (anon) — valida o token e emite a sessão do portal.
create or replace function public.portal_login_magic(p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rec    record;
  v_dev    record;
  v_sessao jsonb;
begin
  if p_token is null or length(p_token) < 20 then
    return jsonb_build_object('ok', false, 'erro', 'Link inválido.');
  end if;

  select devedor_id into v_rec
  from public.portal_magic_tokens
  where token = p_token and expira_em > now()
  limit 1;

  if v_rec.devedor_id is null then
    return jsonb_build_object('ok', false, 'erro', 'Link expirado. Entre com CPF e data de nascimento.');
  end if;

  select id, nome into v_dev from public.devedores where id = v_rec.devedor_id limit 1;
  if v_dev.id is null then
    return jsonb_build_object('ok', false, 'erro', 'Cadastro não encontrado.');
  end if;

  -- Marca o 1º uso (não invalida — reutilizável até expirar).
  update public.portal_magic_tokens set usado_em = coalesce(usado_em, now()) where token = p_token;

  v_sessao := public._portal_emitir_sessao(v_dev.id, null);

  return jsonb_build_object(
    'ok', true,
    'devedor_id', v_dev.id,
    'nome', v_dev.nome,
    'sessao_token', v_sessao->>'sessao_token',
    'expira_em', v_sessao->>'expira_em'
  );
end;
$function$;

revoke all on function public.portal_login_magic(text) from public;
grant execute on function public.portal_login_magic(text) to anon, authenticated;
