-- Portal do cliente (cedente): "Enviar nova cobrança" e "Dúvidas sobre um caso".
-- Antes o formulário de nova cobrança só mostrava um aviso "em breve" e não gravava nada.
-- Agora as duas coisas caem nesta tabela; a equipe vê e responde no painel, e a resposta
-- aparece no histórico do portal.
--
-- Escopo do cedente: o cliente do ref_id (vínculo real app_users.ref_id -> clientes.id)
-- mais os clientes do grupo (cedente_cliente_ids()). A dúvida só aceita cobrança que o
-- cedente pode ver (cedente_pode_cobranca).
-- INSERT só pelas RPCs security definer; o cedente não tem policy de INSERT/UPDATE.
-- Aplicar manual no SQL Editor. Idempotente.

create table if not exists public.portal_solicitacoes (
  id             uuid primary key default gen_random_uuid(),
  tipo           text not null check (tipo in ('nova_cobranca','duvida')),
  cliente_id     uuid not null references public.clientes(id),
  cobranca_id    text,                              -- só p/ dúvida
  criado_em      timestamptz not null default now(),
  criado_por     uuid default auth.uid(),
  -- nova cobrança
  devedor_nome   text,
  devedor_doc    text,
  devedor_tel    text,
  devedor_email  text,
  valor          numeric(14,2),
  vencimento     date,
  titulo         text,
  -- dúvida (ou observação da nova cobrança)
  mensagem       text,
  status         text not null default 'aberta'
                 check (status in ('aberta','em_analise','respondida','aprovada','recusada')),
  resposta       text,
  respondida_em  timestamptz,
  respondida_por uuid
);
create index if not exists idx_portal_solic_cliente on public.portal_solicitacoes(cliente_id, criado_em desc);
create index if not exists idx_portal_solic_status  on public.portal_solicitacoes(status, criado_em desc);

alter table public.portal_solicitacoes enable row level security;
grant select, insert, update, delete on public.portal_solicitacoes to authenticated;  -- a RLS filtra

-- Clientes que o cedente logado enxerga.
create or replace function public.portal_meus_clientes()
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select au.ref_id::uuid from public.app_users au
   where au.id = auth.uid() and au.papel = 'cedente'
     and coalesce(au.ativo, true) and au.ref_id ~ '^[0-9a-fA-F-]{36}$'
  union
  select public.cedente_cliente_ids()
   where exists (select 1 from public.app_users au
                  where au.id = auth.uid() and au.papel = 'cedente' and coalesce(au.ativo, true));
$$;
revoke all on function public.portal_meus_clientes() from public;
grant execute on function public.portal_meus_clientes() to authenticated;

drop policy if exists portal_solic_cedente_sel on public.portal_solicitacoes;
create policy portal_solic_cedente_sel on public.portal_solicitacoes
  for select to authenticated
  using (cliente_id in (select public.portal_meus_clientes()));

drop policy if exists portal_solic_staff_all on public.portal_solicitacoes;
create policy portal_solic_staff_all on public.portal_solicitacoes
  for all to authenticated
  using (current_user_papel() in ('proprietario','colaborador'))
  with check (current_user_papel() in ('proprietario','colaborador'));

-- Nova cobrança enviada pelo cliente.
create or replace function public.cedente_nova_solicitacao(
  p_devedor_nome text, p_devedor_doc text, p_devedor_tel text, p_devedor_email text,
  p_valor numeric, p_vencimento date, p_titulo text, p_obs text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cli uuid; v_id uuid; v_nome text;
begin
  if coalesce(btrim(p_devedor_nome),'')='' then raise exception 'Informe o nome do devedor.'; end if;
  if p_valor is null or p_valor <= 0 then raise exception 'Informe o valor da dívida.'; end if;
  select au.ref_id::uuid into v_cli from public.app_users au
   where au.id = auth.uid() and au.papel = 'cedente' and coalesce(au.ativo,true)
     and au.ref_id ~ '^[0-9a-fA-F-]{36}$';
  if v_cli is null then raise exception 'Sem cliente vinculado a este acesso.'; end if;
  select nome into v_nome from public.clientes where id = v_cli;
  insert into public.portal_solicitacoes(tipo, cliente_id, devedor_nome, devedor_doc, devedor_tel,
         devedor_email, valor, vencimento, titulo, mensagem)
  values ('nova_cobranca', v_cli, left(btrim(p_devedor_nome),200), left(btrim(coalesce(p_devedor_doc,'')),30),
          left(btrim(coalesce(p_devedor_tel,'')),30), left(btrim(coalesce(p_devedor_email,'')),200),
          round(p_valor,2), p_vencimento, left(btrim(coalesce(p_titulo,'')),200), left(btrim(coalesce(p_obs,'')),4000))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'clienteNome', coalesce(v_nome,''));
end; $$;
revoke all on function public.cedente_nova_solicitacao(text,text,text,text,numeric,date,text,text) from public;
grant execute on function public.cedente_nova_solicitacao(text,text,text,text,numeric,date,text,text) to authenticated;

-- Dúvida sobre um caso do cliente.
create or replace function public.cedente_nova_duvida(p_cobranca_id text, p_mensagem text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cli uuid; v_id uuid; v_nome text;
begin
  if coalesce(btrim(p_mensagem),'')='' then raise exception 'Escreva a sua dúvida.'; end if;
  if coalesce(btrim(p_cobranca_id),'')='' then raise exception 'Escolha o caso.'; end if;
  if not public.cedente_pode_cobranca(p_cobranca_id) then
    raise exception 'Este caso não pertence ao seu acesso.';
  end if;
  select c.cliente_id into v_cli from public.cobrancas c where c.id::text = p_cobranca_id;
  select nome into v_nome from public.clientes where id = v_cli;
  insert into public.portal_solicitacoes(tipo, cliente_id, cobranca_id, mensagem)
  values ('duvida', v_cli, p_cobranca_id, left(btrim(p_mensagem),4000))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'clienteNome', coalesce(v_nome,''));
end; $$;
revoke all on function public.cedente_nova_duvida(text,text) from public;
grant execute on function public.cedente_nova_duvida(text,text) to authenticated;
