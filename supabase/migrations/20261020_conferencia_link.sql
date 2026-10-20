-- Bancada de conferência por LINK: o credor sem login no portal recebe um link secreto
-- (painel.cobrasq.com.br/conferencia#<token>) que mostra só os títulos dele e grava as
-- respostas. As respostas caem nas mesmas conferencia_perguntas que a equipe já lê.
--
-- Depende de 20261019_bancada_conferencia.sql.
-- conferencia_links: só a equipe enxerga (proprietário cria e revoga; colaborador lê).
-- anon NÃO lê tabela nenhuma: entra só pelas duas RPCs security definer abaixo, que exigem
-- um token ativo (não revogado, não vencido) e só alcançam o cliente daquele token.
-- Um link ativo por cliente; "gerar de novo" = revogar o antigo e criar outro.
-- Aplicar manual no SQL Editor. Idempotente. Rollback: 20261020_conferencia_link_rollback.sql

create table if not exists public.conferencia_links (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references public.clientes(id),
  -- 24 bytes aleatórios = 48 caracteres hex; vai no fragmento (#) da URL, fora dos logs
  token            text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  criado_em        timestamptz not null default now(),
  criado_por       uuid default auth.uid(),
  revogado_em      timestamptz,
  expira_em        timestamptz,                  -- null = não vence
  ultimo_acesso_em timestamptz,
  acessos          int not null default 0
);
create unique index if not exists conferencia_links_um_ativo
  on public.conferencia_links(cliente_id) where revogado_em is null;

alter table public.conferencia_links enable row level security;
revoke all on public.conferencia_links from anon;
grant select, insert, update, delete on public.conferencia_links to authenticated;  -- a RLS filtra
revoke truncate on public.conferencia_links from authenticated;

drop policy if exists conf_links_staff_sel on public.conferencia_links;
create policy conf_links_staff_sel on public.conferencia_links
  for select to authenticated
  using (current_user_papel() in ('proprietario','colaborador'));

drop policy if exists conf_links_owner_all on public.conferencia_links;
create policy conf_links_owner_all on public.conferencia_links
  for all to authenticated
  using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');

-- Quem respondeu pelo link (null = pelo portal, ver respondida_por)
alter table public.conferencia_perguntas
  add column if not exists respondida_link uuid references public.conferencia_links(id);

-- ── validação do token (uso interno das duas RPCs) ───────────────────────────
create or replace function public._conferencia_link_ativo(p_token text)
returns public.conferencia_links language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare v public.conferencia_links%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then
    raise exception 'Este link não é válido ou foi desativado.';
  end if;
  select * into v from public.conferencia_links
   where token = p_token and revogado_em is null and (expira_em is null or expira_em > now());
  if v.id is null then
    raise exception 'Este link não é válido ou foi desativado.';
  end if;
  return v;
end; $$;
revoke all on function public._conferencia_link_ativo(text) from public;
revoke all on function public._conferencia_link_ativo(text) from anon, authenticated;

-- ── leitura pelo link ────────────────────────────────────────────────────────
-- Devolve o nome do cliente, os itens ativos e as perguntas (as de item desativado ficam de fora).
create or replace function public.conferencia_por_link(p_token text)
returns jsonb language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare v public.conferencia_links%rowtype;
begin
  v := public._conferencia_link_ativo(p_token);
  update public.conferencia_links
     set ultimo_acesso_em = now(), acessos = acessos + 1
   where id = v.id;
  return jsonb_build_object(
    'cliente', (select c.nome from public.clientes c where c.id = v.cliente_id),
    'itens', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'devedor', i.devedor, 'titulo', i.titulo,
                                          'ordem', i.ordem, 'dados', i.dados) order by i.ordem)
        from public.conferencia_itens i
       where i.cliente_id = v.cliente_id and i.ativo), '[]'::jsonb),
    'perguntas', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'item_id', p.item_id, 'ordem', p.ordem,
                                          'pergunta', p.pergunta, 'resposta', p.resposta,
                                          'respondida_em', p.respondida_em) order by p.ordem)
        from public.conferencia_perguntas p
       where p.cliente_id = v.cliente_id
         and (p.item_id is null or exists (select 1 from public.conferencia_itens i
                                            where i.id = p.item_id and i.ativo))), '[]'::jsonb));
end; $$;
revoke all on function public.conferencia_por_link(text) from public;
grant execute on function public.conferencia_por_link(text) to anon, authenticated;

-- ── resposta pelo link ───────────────────────────────────────────────────────
-- Mesma regra da cedente_responder_conferencia: vazio apaga; a anterior vai para o histórico.
create or replace function public.conferencia_responder_link(p_token text, p_pergunta_id uuid, p_resposta text)
returns jsonb language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare v public.conferencia_links%rowtype; v_row public.conferencia_perguntas%rowtype; v_txt text;
begin
  v := public._conferencia_link_ativo(p_token);
  select * into v_row from public.conferencia_perguntas where id = p_pergunta_id;
  if v_row.id is null
     or v_row.cliente_id <> v.cliente_id
     or (v_row.item_id is not null and not exists (
           select 1 from public.conferencia_itens i where i.id = v_row.item_id and i.ativo)) then
    raise exception 'Esta pergunta não pertence a este link.';
  end if;
  v_txt := nullif(left(btrim(coalesce(p_resposta,'')), 4000), '');
  update public.conferencia_perguntas
     set resposta        = v_txt,
         respondida_em   = case when v_txt is null then null else now() end,
         respondida_por  = null,
         respondida_link = case when v_txt is null then null else v.id end,
         historico       = case when v_row.resposta is null then historico
                                else historico || jsonb_build_array(jsonb_build_object(
                                       'resposta', v_row.resposta, 'em', v_row.respondida_em,
                                       'por', v_row.respondida_por, 'link', v_row.respondida_link)) end
   where id = p_pergunta_id;
  return jsonb_build_object('id', p_pergunta_id, 'resposta', v_txt,
                            'respondida_em', case when v_txt is null then null else now() end);
end; $$;
revoke all on function public.conferencia_responder_link(text,uuid,text) from public;
grant execute on function public.conferencia_responder_link(text,uuid,text) to anon, authenticated;

-- ── resposta pelo portal: passa a limpar respondida_link e a guardá-lo no histórico ──
create or replace function public.cedente_responder_conferencia(p_pergunta_id uuid, p_resposta text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.conferencia_perguntas%rowtype; v_txt text;
begin
  select * into v_row from public.conferencia_perguntas where id = p_pergunta_id;
  if v_row.id is null
     -- not exists, não "not in": um null na lista faria o not in dar null e passar
     or not exists (select 1 from public.portal_meus_clientes() c where c = v_row.cliente_id)
     or (v_row.item_id is not null and not exists (
           select 1 from public.conferencia_itens i where i.id = v_row.item_id and i.ativo)) then
    raise exception 'Esta pergunta não pertence ao seu acesso.';
  end if;
  v_txt := nullif(left(btrim(coalesce(p_resposta,'')), 4000), '');
  update public.conferencia_perguntas
     set resposta        = v_txt,
         respondida_em   = case when v_txt is null then null else now() end,
         respondida_por  = case when v_txt is null then null else auth.uid() end,
         respondida_link = null,
         historico       = case when v_row.resposta is null then historico
                                else historico || jsonb_build_array(jsonb_build_object(
                                       'resposta', v_row.resposta, 'em', v_row.respondida_em,
                                       'por', v_row.respondida_por, 'link', v_row.respondida_link)) end
   where id = p_pergunta_id;
  return jsonb_build_object('id', p_pergunta_id, 'resposta', v_txt,
                            'respondida_em', case when v_txt is null then null else now() end);
end; $$;
revoke all on function public.cedente_responder_conferencia(uuid,text) from public;
revoke all on function public.cedente_responder_conferencia(uuid,text) from anon;
grant execute on function public.cedente_responder_conferencia(uuid,text) to authenticated;
