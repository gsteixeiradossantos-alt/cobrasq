-- ============================================================================
-- PREPARADA — NÃO APLICAR SEM REVISÃO
-- ============================================================================
-- Portal do Devedor — 2 correções (2026-07-06)
--
--   Achado 1: portal abre VAZIO. renderPortalDevedor dependia de DB.devedores,
--             que para o devedor anon (sem RLS de staff) vem vazio. Criamos a
--             RPC SECURITY DEFINER `portal_meu_caso` que devolve SÓ o caso do
--             próprio devedor (dados, dívida da cobrança, acordos+parcelas).
--
--   Achado 2: login CPF + data de nascimento sempre falha (fazia lookup em
--             DB.devedores, vazio para anon). Criamos a RPC SECURITY DEFINER
--             `portal_login_nascimento` que confere CPF+data_nascimento no banco.
--
-- DECISÃO DE SEGURANÇA (anti-vazamento, lição do P0):
--   `portal_meu_caso` NÃO aceita `devedor_id` cru. Exige PROVA DE POSSE: um
--   token de sessão opaco (`portal_sessoes`) que só o servidor emite APÓS a
--   autenticação (validação do token WhatsApp OU CPF+nascimento). Sem o token
--   de sessão não há como pedir o caso de outro devedor — o `devedor_id` é
--   resolvido server-side a partir da sessão, nunca vem do cliente.
--
--   `portal_login_nascimento` tem rate-limit por CPF (anti-enumeração) e
--   retorna erro GENÉRICO (não revela se o CPF existe), no espírito do
--   `portal_emitir_token`. As tabelas de apoio têm RLS ligada e SEM policy —
--   só são acessíveis via estas funções SECURITY DEFINER.
--
-- ROLLBACK: ver 20260706_portal_meu_caso_rollback.sql
--
-- Aplicar manual no SQL Editor do Supabase APÓS revisão. NÃO rodar db push cego.
-- ============================================================================

-- ── Tabela de sessões do portal (prova de posse) ──────────────────────────
create table if not exists public.portal_sessoes (
  token       text primary key,
  devedor_id  uuid not null references public.devedores(id) on delete cascade,
  cpf         text,
  criado_em   timestamptz not null default now(),
  expira_em   timestamptz not null,
  ip          text,
  user_agent  text
);
create index if not exists idx_portal_sessoes_devedor on public.portal_sessoes(devedor_id);
create index if not exists idx_portal_sessoes_expira  on public.portal_sessoes(expira_em);

alter table public.portal_sessoes enable row level security;
-- Sem policy de propósito: só as funções SECURITY DEFINER abaixo tocam a tabela.
-- Nada de GRANT para anon/authenticated na tabela.

-- ── Tabela de tentativas do login por nascimento (rate-limit / anti-enum) ──
create table if not exists public.portal_login_tentativas (
  id         uuid primary key default gen_random_uuid(),
  cpf        text,
  sucesso    boolean not null default false,
  ip         text,
  criado_em  timestamptz not null default now()
);
create index if not exists idx_portal_login_tent_cpf
  on public.portal_login_tentativas(cpf, criado_em desc);

alter table public.portal_login_tentativas enable row level security;
-- Sem policy: só a função SECURITY DEFINER escreve/lê.

-- ── Helper interno: emite um token de sessão opaco (~244 bits) ─────────────
-- Chamado apenas de dentro das funções SECURITY DEFINER (roda como owner);
-- não recebe GRANT para anon/authenticated.
create or replace function public._portal_emitir_sessao(p_devedor_id uuid, p_cpf text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_token text;
  v_expira timestamptz;
begin
  -- gen_random_uuid() é core no PG13+; dois UUIDs (hex) = token forte, sem depender de pgcrypto.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expira := now() + interval '2 hours';

  insert into public.portal_sessoes (token, devedor_id, cpf, expira_em)
  values (v_token, p_devedor_id, p_cpf, v_expira);

  -- Higiene: limpa sessões expiradas antigas (best-effort).
  delete from public.portal_sessoes where expira_em < now() - interval '1 day';

  return jsonb_build_object('sessao_token', v_token, 'expira_em', v_expira::text);
end;
$function$;

revoke all on function public._portal_emitir_sessao(uuid, text) from public;

-- ── Achado 2: login por CPF + data de nascimento ──────────────────────────
create or replace function public.portal_login_nascimento(p_cpf text, p_nascimento date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cpf_digits text;
  v_devedor record;
  v_tentativas int;
  v_sessao jsonb;
  v_tel_mask text;
begin
  v_cpf_digits := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');

  if length(v_cpf_digits) <> 11 then
    return jsonb_build_object('ok', false, 'erro', 'CPF inválido.');
  end if;
  if p_nascimento is null then
    return jsonb_build_object('ok', false, 'erro', 'Informe a data de nascimento.');
  end if;

  -- Rate-limit anti-enumeração: máx. 5 tentativas por CPF a cada 15 min.
  select count(*) into v_tentativas
  from public.portal_login_tentativas
  where cpf = v_cpf_digits
    and criado_em > now() - interval '15 minutes';

  if v_tentativas >= 5 then
    return jsonb_build_object('ok', false,
      'erro', 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  end if;

  select id, nome, telefone
    into v_devedor
  from public.devedores
  where regexp_replace(coalesce(doc, ''), '\D', '', 'g') = v_cpf_digits
    and data_nascimento = p_nascimento
    and coalesce(arquivado, false) = false
  limit 1;

  -- Registra a tentativa (sucesso/fracasso) para o rate-limit.
  insert into public.portal_login_tentativas (cpf, sucesso)
  values (v_cpf_digits, v_devedor.id is not null);

  if v_devedor.id is null then
    -- Erro GENÉRICO: não revela se o CPF existe (anti-enumeração).
    return jsonb_build_object('ok', false,
      'erro', 'CPF ou data de nascimento não conferem.');
  end if;

  v_tel_mask := case
    when length(regexp_replace(coalesce(v_devedor.telefone, ''), '\D', '', 'g')) >= 4
      then '(••) •••••-' || right(regexp_replace(v_devedor.telefone, '\D', '', 'g'), 4)
    else null
  end;

  v_sessao := public._portal_emitir_sessao(v_devedor.id, v_cpf_digits);

  return jsonb_build_object(
    'ok', true,
    'devedor_id', v_devedor.id,
    'nome', v_devedor.nome,
    'telefone_mask', v_tel_mask,
    'sessao_token', v_sessao->>'sessao_token',
    'expira_em', v_sessao->>'expira_em'
  );
end;
$function$;

revoke all on function public.portal_login_nascimento(text, date) from public;
grant execute on function public.portal_login_nascimento(text, date) to anon, authenticated;

-- ── Achado 1: dados do próprio caso (exige token de sessão) ───────────────
create or replace function public.portal_meu_caso(p_sessao_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_devedor_id uuid;
  v_dev record;
  v_doc text;
  v_doc_mask text;
  v_divida jsonb;
  v_acordos jsonb;
begin
  if p_sessao_token is null or length(p_sessao_token) < 20 then
    return jsonb_build_object('ok', false, 'erro', 'Sessão inválida.');
  end if;

  -- Prova de posse: resolve o devedor A PARTIR da sessão (nunca do cliente).
  select devedor_id into v_devedor_id
  from public.portal_sessoes
  where token = p_sessao_token
    and expira_em > now()
  limit 1;

  if v_devedor_id is null then
    return jsonb_build_object('ok', false,
      'erro', 'Sessão expirada. Entre novamente para ver seu caso.');
  end if;

  select id, nome, doc, telefone into v_dev
  from public.devedores
  where id = v_devedor_id
  limit 1;

  if v_dev.id is null then
    return jsonb_build_object('ok', false, 'erro', 'Cadastro não encontrado.');
  end if;

  v_doc := regexp_replace(coalesce(v_dev.doc, ''), '\D', '', 'g');
  v_doc_mask := case
    when length(v_doc) = 11
      then '•••.•••.' || substr(v_doc, 7, 3) || '-' || substr(v_doc, 10, 2)
    when length(v_doc) >= 4
      then '••••' || right(v_doc, 4)
    else ''
  end;

  -- Dívida: cobrança ligada ao devedor via cobranca_partes (prefere a principal,
  -- não-arquivada, mais recente). SECURITY DEFINER escopa manualmente a UM devedor.
  select jsonb_build_object(
           'valor_atual', c.valor_atual,
           'valor_orig',  c.valor_orig,
           'vencimento',  c.vencimento,
           'status',      c.status
         )
    into v_divida
  from public.cobranca_partes cp
  join public.cobrancas c on c.id = cp.cobranca_id
  where cp.devedor_id = v_devedor_id
    and coalesce(c.arquivado, false) = false
  order by coalesce(cp.principal, false) desc, c.created_at desc nulls last
  limit 1;

  -- Acordos + parcelas SÓ deste devedor.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',         a.id,
               'valorTotal', a.valor_total,
               'status',     a.status,
               'forma',      a.forma,
               'parcelas',   coalesce(a.parcelas, '[]'::jsonb)
             )
             order by a.created_at
           ),
           '[]'::jsonb
         )
    into v_acordos
  from public.acordos a
  where a.devedor_id = v_devedor_id;

  return jsonb_build_object(
    'ok', true,
    'devedor', jsonb_build_object('id', v_dev.id, 'nome', v_dev.nome, 'doc_mask', v_doc_mask),
    'divida',  v_divida,
    'acordos', v_acordos
  );
end;
$function$;

revoke all on function public.portal_meu_caso(text) from public;
grant execute on function public.portal_meu_caso(text) to anon, authenticated;

-- ── Achado 1 (cont.): o login por token WhatsApp também emite sessão ──────
-- Redefinição de portal_validar_token: MESMO comportamento de antes
-- (valida/consome o token de 6 dígitos) + emite o token de sessão do portal
-- para o portal_meu_caso conseguir provar posse. Retorno retrocompatível
-- (mantém ok + devedor_id; acrescenta sessao_token + expira_em).
create or replace function public.portal_validar_token(p_cpf text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cpf_digits text;
  v_token_clean text;
  v_row record;
  v_sessao jsonb;
begin
  v_cpf_digits := regexp_replace(p_cpf, '\D', '', 'g');
  v_token_clean := regexp_replace(p_token, '\D', '', 'g');

  if length(v_token_clean) <> 6 then
    return jsonb_build_object('ok', false, 'erro', 'Código deve ter 6 dígitos.');
  end if;

  select t.cpf, t.token, t.devedor_id, t.expira_em, t.usado_em
    into v_row
  from public.portal_tokens t
  where t.cpf = v_cpf_digits and t.token = v_token_clean
  order by t.enviado_em desc limit 1;

  if v_row.cpf is null then
    return jsonb_build_object('ok', false, 'erro', 'Código incorreto.');
  end if;
  if v_row.usado_em is not null then
    return jsonb_build_object('ok', false, 'erro', 'Código já utilizado.');
  end if;
  if v_row.expira_em < now() then
    return jsonb_build_object('ok', false, 'erro', 'Código expirado. Solicite um novo.');
  end if;

  update public.portal_tokens
    set usado_em = now()
  where cpf = v_row.cpf and token = v_row.token;

  v_sessao := public._portal_emitir_sessao(v_row.devedor_id, v_row.cpf);

  return jsonb_build_object(
    'ok', true,
    'devedor_id', v_row.devedor_id,
    'sessao_token', v_sessao->>'sessao_token',
    'expira_em', v_sessao->>'expira_em'
  );
end;
$function$;

revoke all on function public.portal_validar_token(text, text) from public;
grant execute on function public.portal_validar_token(text, text) to anon, authenticated;
