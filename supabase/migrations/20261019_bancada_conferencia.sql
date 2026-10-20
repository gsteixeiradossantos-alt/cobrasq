-- Bancada de conferência do cliente (cedente): títulos digitalizados (notas promissórias,
-- cheques) que precisam de resposta do credor antes da cobrança — está em aberto, valor de
-- hoje, telefone, CPF, qual dado está certo. O cliente entra no portal com o próprio login,
-- vê só os itens dele e responde pergunta por pergunta; a equipe lê as respostas no painel.
--
-- Escopo do cedente: portal_meus_clientes() (20261016b) — o cliente do ref_id mais os do
-- grupo, só com login ativo e papel 'cedente'. Devedor e anon: nada.
-- O cedente NÃO tem policy de INSERT/UPDATE/DELETE: responde só pela RPC
-- cedente_responder_conferencia, que confere se a pergunta é de um cliente dele.
-- Proprietário: tudo (é quem carrega os itens). Colaborador: só leitura.
-- Os itens em si (nomes, valores) entram por seed fora do git (scripts/bancada_seed.py).
-- Aplicar manual no SQL Editor. Idempotente. Rollback: 20261019_bancada_conferencia_rollback.sql

create table if not exists public.conferencia_itens (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes(id),
  arquivo     text not null,                    -- nº do PDF digitalizado (chave do seed)
  devedor     text not null,
  titulo      text,                             -- descrição do título, já em texto ao cliente
  ordem       int  not null default 0,
  dados       jsonb not null default '{}'::jsonb,
              -- {"lido":[{"rotulo","valor"}], "cadastro":[{"rotulo","valor"}], "cadastro_nota":text}
  ativo       boolean not null default true,    -- false = some do portal sem apagar
  criado_em   timestamptz not null default now(),
  constraint conferencia_itens_id_cliente_uk unique (id, cliente_id),
  constraint conferencia_itens_arquivo_uk unique (cliente_id, arquivo)
);

create table if not exists public.conferencia_perguntas (
  id             uuid primary key default gen_random_uuid(),
  cliente_id     uuid not null references public.clientes(id),
  item_id        uuid,                          -- null = pergunta geral ao cliente
  ordem          int  not null default 0,
  pergunta       text not null,
  resposta       text,
  respondida_em  timestamptz,
  respondida_por uuid,
  historico      jsonb not null default '[]'::jsonb,  -- respostas anteriores (sobrescritas)
  criado_em      timestamptz not null default now(),
  -- a pergunta só pode apontar para item do MESMO cliente
  constraint conferencia_perguntas_item_fk foreign key (item_id, cliente_id)
    references public.conferencia_itens(id, cliente_id) on delete cascade,
  constraint conferencia_perguntas_ordem_uk unique nulls not distinct (cliente_id, item_id, ordem)
);
create index if not exists idx_conf_itens_cliente on public.conferencia_itens(cliente_id, ordem);
create index if not exists idx_conf_perg_cliente  on public.conferencia_perguntas(cliente_id, item_id, ordem);

alter table public.conferencia_itens     enable row level security;
alter table public.conferencia_perguntas enable row level security;
revoke all on public.conferencia_itens, public.conferencia_perguntas from anon;
grant select, insert, update, delete on public.conferencia_itens, public.conferencia_perguntas to authenticated;  -- a RLS filtra
-- TRUNCATE vem por padrão do Supabase e passa por cima da RLS
revoke truncate on public.conferencia_itens, public.conferencia_perguntas from authenticated;

-- ── itens ────────────────────────────────────────────────────────────────────
drop policy if exists conf_itens_cedente_sel on public.conferencia_itens;
create policy conf_itens_cedente_sel on public.conferencia_itens
  for select to authenticated
  using (ativo and cliente_id in (select public.portal_meus_clientes()));

drop policy if exists conf_itens_staff_sel on public.conferencia_itens;
create policy conf_itens_staff_sel on public.conferencia_itens
  for select to authenticated
  using (current_user_papel() in ('proprietario','colaborador'));

drop policy if exists conf_itens_owner_all on public.conferencia_itens;
create policy conf_itens_owner_all on public.conferencia_itens
  for all to authenticated
  using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');

-- ── perguntas ────────────────────────────────────────────────────────────────
-- Pergunta de item desativado também some para o cliente.
drop policy if exists conf_perg_cedente_sel on public.conferencia_perguntas;
create policy conf_perg_cedente_sel on public.conferencia_perguntas
  for select to authenticated
  using (cliente_id in (select public.portal_meus_clientes())
         and (item_id is null or exists (select 1 from public.conferencia_itens i
                                          where i.id = item_id and i.ativo)));

drop policy if exists conf_perg_staff_sel on public.conferencia_perguntas;
create policy conf_perg_staff_sel on public.conferencia_perguntas
  for select to authenticated
  using (current_user_papel() in ('proprietario','colaborador'));

drop policy if exists conf_perg_owner_all on public.conferencia_perguntas;
create policy conf_perg_owner_all on public.conferencia_perguntas
  for all to authenticated
  using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');

-- ── resposta do cliente ──────────────────────────────────────────────────────
-- Resposta vazia apaga a resposta (volta a "sem resposta"). A anterior fica no histórico.
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
     set resposta       = v_txt,
         respondida_em  = case when v_txt is null then null else now() end,
         respondida_por = case when v_txt is null then null else auth.uid() end,
         historico      = case when v_row.resposta is null then historico
                               else historico || jsonb_build_array(jsonb_build_object(
                                      'resposta', v_row.resposta, 'em', v_row.respondida_em,
                                      'por', v_row.respondida_por)) end
   where id = p_pergunta_id;
  return jsonb_build_object('id', p_pergunta_id, 'resposta', v_txt,
                            'respondida_em', case when v_txt is null then null else now() end);
end; $$;
revoke all on function public.cedente_responder_conferencia(uuid,text) from public;
-- o Supabase dá execute a anon em toda função nova (default privileges); "from public" não tira
revoke all on function public.cedente_responder_conferencia(uuid,text) from anon;
grant execute on function public.cedente_responder_conferencia(uuid,text) to authenticated;
