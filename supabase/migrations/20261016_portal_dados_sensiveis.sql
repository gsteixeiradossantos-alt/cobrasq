-- 20261016_portal_dados_sensiveis.sql
--
-- Portal do cliente (cedente): o que ele lê pela API, não só pela tela.
-- Pedido do Gustavo em 16/10/2026, depois de ver "Pagamento recebido — R$ 356,00" no
-- histórico do portal: "revise no acesso em geral para ver se aparece algum outro dado
-- sensível ou em outro local". O PR #926 tirou da TELA; esta migração tira do BANCO.
--
-- RLS filtra linha, não coluna. Com SELECT direto em devedores/cobrancas, o cedente
-- recebia observacoes, assigned_to, telefone/e-mail, metadata.obs, notas internas do
-- histórico e o cadastro completo do devedor-parte de OUTRO credor. Agora:
--
--  1. devedor_eventos: o cedente deixa de ler asaas_pagamento_recebido/atrasado.
--  2. alertas_vinculo e ag_*: só a equipe.
--  3. devedores/cobrancas: some a leitura direta do cedente. No lugar, as RPCs
--     portal_devedores() e portal_cobrancas() entregam só o que o portal usa
--     (lista branca de colunas e de chaves do metadata).
--  4. devedor-parte de outro credor: só id, nome e documento.
--  9. grupos_economicos: equipe + o próprio grupo do cedente.
-- 10. acordos e peticao_provas: o cedente de grupo econômico passa a ler também
--     (antes só o app_user_id direto).
--
-- Armadilha: subconsulta dentro de policy roda com a RLS de quem chama. Fechar
-- devedores/cobrancas para o cedente quebraria toda policy dele que faz subconsulta
-- nessas tabelas (partes, terceiros, documentos, storage, intimações, eventos, acordos,
-- provas). Por isso todas passam a usar as funções SECURITY DEFINER abaixo, com a
-- MESMA lógica de escopo das policies antigas (app_user_id + grupo econômico +
-- cliente_grupo).
--
-- Efeito colateral conhecido: dev_dividas (policies "via devedor", roles public) deixa
-- de ser legível/gravável pelo cedente, porque dependia de ele ler devedores. O portal
-- não usa dev_dividas.
--
-- Rollback: 20261016_portal_dados_sensiveis_rollback.sql

begin;

-- ── Funções de escopo do cedente ──────────────────────────────────────────────
-- Mesma união das policies antigas: app_user_id direto + grupo econômico + cliente_grupo.
create or replace function public.cedente_cliente_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select cl.id from clientes cl where cl.app_user_id = auth.uid()
  union
  select cl.id from clientes cl
   where current_user_grupo_economico() is not null
     and cl.grupo_economico_id = current_user_grupo_economico()
  union
  select cl.id from clientes cl
   where current_user_grupo() is not null
     and (cl.cliente_grupo_id = current_user_grupo() or cl.id = current_user_grupo())
$$;

create or replace function public.cedente_cobranca_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select c.id from cobrancas c where c.cliente_id in (select public.cedente_cliente_ids())
$$;

-- Devedores cadastrados nos clientes do cedente (não inclui parte de outro credor).
create or replace function public.cedente_devedor_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select d.id from devedores d where d.cliente_id in (select public.cedente_cliente_ids())
$$;

revoke all on function public.cedente_cliente_ids()  from public, anon;
revoke all on function public.cedente_cobranca_ids() from public, anon;
revoke all on function public.cedente_devedor_ids()  from public, anon;
grant execute on function public.cedente_cliente_ids()  to authenticated;
grant execute on function public.cedente_cobranca_ids() to authenticated;
grant execute on function public.cedente_devedor_ids()  to authenticated;

-- ── Itens 3 e 4: fim da leitura direta de devedores/cobrancas pelo cedente ────
drop policy if exists devedores_cedente_scope on public.devedores;
drop policy if exists devedores_cedente_grupo on public.devedores;
drop policy if exists devedores_cedente_parte on public.devedores;
drop policy if exists cobrancas_cedente_scope on public.cobrancas;
drop policy if exists cobrancas_cedente_grupo on public.cobrancas;

-- metadata.historico visível ao cliente: comprovante dele ou item marcado visível
-- (mesma regra de cpHistLegadoCliente no index.html).
create or replace function public._portal_hist(h jsonb)
returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(h) = 'array' then h else '[]'::jsonb end) x
   where x->>'tipo' = 'Comprovante'
      or x->>'visivel_cliente' = 'true'
      or x->>'visivelCliente' = 'true'
$$;
revoke all on function public._portal_hist(jsonb) from public, anon;
grant execute on function public._portal_hist(jsonb) to authenticated;

create or replace function public.portal_devedores()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(linha), '[]'::jsonb) from (
    -- cadastro do próprio cedente: colunas não internas + metadata em lista branca
    select jsonb_build_object(
        'id', d.id, 'cliente_id', d.cliente_id, 'nome', d.nome, 'doc', d.doc,
        'arquivado', d.arquivado, 'is_draft', d.is_draft,
        'created_at', d.created_at, 'updated_at', d.updated_at,
        'cep', d.cep, 'rua', d.rua, 'numero', d.numero, 'complemento', d.complemento,
        'bairro', d.bairro, 'cidade', d.cidade, 'uf', d.uf, 'endereco', d.endereco,
        'metadata', (
          select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
            from jsonb_each(case when jsonb_typeof(d.metadata) = 'object'
                                 then d.metadata else '{}'::jsonb end) e(k, v)
           where k in ('documentos','comprovantes','titulo','submissaoData',
                       'submissaoCedenteNome','revisaoNota','origem','status_aprovacao',
                       'isDraft','processoNum','vara','vencimento','credorOriginal')
        ) || jsonb_build_object('historico', public._portal_hist(d.metadata->'historico'))
      ) as linha
      from devedores d
     where public.current_user_papel() = 'cedente'
       and d.cliente_id in (select public.cedente_cliente_ids())
    union all
    -- devedor-parte de cobrança do cedente, cadastrado em OUTRO credor: só nome e documento
    select jsonb_build_object('id', d.id, 'nome', d.nome, 'doc', d.doc, 'parte_externa', true)
      from devedores d
     where public.current_user_papel() = 'cedente'
       and d.id in (select p.devedor_id from cobranca_partes p
                     where p.cobranca_id in (select public.cedente_cobranca_ids()))
       and d.id not in (select public.cedente_devedor_ids())
  ) t
$$;

create or replace function public.portal_cobrancas()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'cliente_id', c.cliente_id, 'status', c.status, 'fase', c.fase,
      'etapa', c.etapa, 'etapa_atualizada_em', c.etapa_atualizada_em,
      'valor_orig', c.valor_orig, 'valor_atual', c.valor_atual, 'valor_capital', c.valor_capital,
      'data_entrada', c.data_entrada, 'vencimento', c.vencimento,
      'divida', case when jsonb_typeof(c.divida) = 'object'
                     then c.divida - 'obs' - 'detalhe' - 'memoria' else c.divida end,
      'tipo_cobranca', c.tipo_cobranca, 'tipo_documento', c.tipo_documento,
      'numero_documento', c.numero_documento, 'origem', c.origem,
      'numero_processo', c.numero_processo, 'vara_tribunal', c.vara_tribunal,
      'arquivado', c.arquivado, 'is_draft', c.is_draft,
      'created_at', c.created_at, 'updated_at', c.updated_at,
      'metadata', (
        select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
          from jsonb_each(case when jsonb_typeof(c.metadata) = 'object'
                               then c.metadata else '{}'::jsonb end) e(k, v)
         where k in ('titulo','processoNum','vara','credorOriginal','vencimento','documentos',
                     'submissaoData','submissaoCedenteNome','origem','isDraft')
      ),
      'cobranca_partes', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', p.id, 'devedor_id', p.devedor_id, 'papel', p.papel, 'principal', p.principal,
                 'devedores', jsonb_build_object('nome', d.nome, 'doc', d.doc))), '[]'::jsonb)
          from cobranca_partes p left join devedores d on d.id = p.devedor_id
         where p.cobranca_id = c.id
      )
    ) order by c.created_at desc, c.id), '[]'::jsonb)
    from cobrancas c
   where public.current_user_papel() = 'cedente'
     and c.cliente_id in (select public.cedente_cliente_ids())
$$;

revoke all on function public.portal_devedores() from public, anon;
revoke all on function public.portal_cobrancas() from public, anon;
grant execute on function public.portal_devedores() to authenticated;
grant execute on function public.portal_cobrancas() to authenticated;

-- ── Item 1: eventos sem pagamento/atraso do Asaas (escopo via função) ─────────
drop policy if exists eventos_cedente_read  on public.devedor_eventos;
drop policy if exists eventos_cedente_grupo on public.devedor_eventos;
create policy eventos_cedente_read on public.devedor_eventos
  for select to authenticated
  using (
    ( tipo = any (array['andamento_judicial','asaas_boletos_emitidos','zapsign_assinado',
                        'acordo_assinado_confirmado','acordo_concluido_auto','acordo_cancelado',
                        'acordo_descumprido','caso_criado','repasse'])
      or ( tipo = any (array['nota_manual','nota','anotacao','historico_legacy','mudanca_status'])
           and ((payload->>'visivel_cliente') = 'true' or (payload->>'visivelCliente') = 'true') ) )
    and ( (cobranca_id is not null and cobranca_id in (select public.cedente_cobranca_ids()))
       or (cobranca_id is null and devedor_id in (select public.cedente_devedor_ids())) )
  );

-- ── Partes e terceiros ────────────────────────────────────────────────────────
drop policy if exists cobranca_partes_cedente_scope    on public.cobranca_partes;
drop policy if exists cobranca_partes_cedente_grupo    on public.cobranca_partes;
drop policy if exists cobranca_terceiros_cedente_scope on public.cobranca_terceiros;
drop policy if exists cobranca_terceiros_cedente_grupo on public.cobranca_terceiros;
create policy cobranca_partes_cedente_scope on public.cobranca_partes
  for select to authenticated using (cobranca_id in (select public.cedente_cobranca_ids()));
create policy cobranca_terceiros_cedente_scope on public.cobranca_terceiros
  for select to authenticated using (cobranca_id in (select public.cedente_cobranca_ids()));

-- ── Documentos (tabela): mesma regra de antes, escopo via função ──────────────
drop policy if exists documentos_cedente_scope on public.documentos;
drop policy if exists documentos_cedente_grupo on public.documentos;
create policy documentos_cedente_scope on public.documentos
  for select to authenticated
  using (
    ( categoria = 'repasse'
      and cobranca_id in (select x::text from public.cedente_cobranca_ids() x) )
    or id in (select r.documento_id from public.repasses_cliente r
               where r.documento_id is not null
                 and r.cliente_id in (select public.cedente_cliente_ids()))
  );

-- ── Documentos (storage) ──────────────────────────────────────────────────────
drop policy if exists documentos_cedente_select       on storage.objects;
drop policy if exists documentos_cedente_grupo_select on storage.objects;
create policy documentos_cedente_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documentos'
    and exists (
      select 1 from public.documentos d
       where d.storage_path = objects.name
         and d.cobranca_id in (select x::text from public.cedente_cobranca_ids() x)
         and ( d.categoria = 'repasse'
            or d.id in (select r.documento_id from public.repasses_cliente r
                         where r.documento_id is not null
                           and r.cliente_id in (select public.cedente_cliente_ids())) )
    )
  );

-- ── Intimações ────────────────────────────────────────────────────────────────
drop policy if exists intimacoes_cedente_select on public.proc_intimacoes;
drop policy if exists intimacoes_cedente_grupo  on public.proc_intimacoes;
create policy intimacoes_cedente_select on public.proc_intimacoes
  for select to authenticated
  using (devedor_id is not null and devedor_id in (select public.cedente_devedor_ids()));

-- ── Item 10: acordos e provas, agora com grupo econômico ──────────────────────
drop policy if exists acordos_cedente_read on public.acordos;
create policy acordos_cedente_read on public.acordos
  for select to authenticated
  using (devedor_id in (select public.cedente_devedor_ids()));

drop policy if exists provas_cedente_read on public.peticao_provas;
create policy provas_cedente_read on public.peticao_provas
  for select to authenticated
  using (devedor_id in (select public.cedente_devedor_ids()));

-- ── Itens 2 e 8: alertas_vinculo e ag_* só para a equipe ──────────────────────
drop policy if exists alertas_vinculo_leitura on public.alertas_vinculo;
create policy alertas_vinculo_leitura on public.alertas_vinculo
  for select to authenticated
  using (public.current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists ag_config_select_authenticated on public.ag_config;
create policy ag_config_select_authenticated on public.ag_config
  for select to authenticated
  using (public.current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists ag_consents_select_authenticated on public.ag_consents;
create policy ag_consents_select_authenticated on public.ag_consents
  for select to authenticated
  using (public.current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists ag_kb_select_authenticated on public.ag_kb_chunks;
create policy ag_kb_select_authenticated on public.ag_kb_chunks
  for select to authenticated
  using (public.current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists ag_msg_select_authenticated on public.ag_messages;
create policy ag_msg_select_authenticated on public.ag_messages
  for select to authenticated
  using (public.current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists ag_rules_select_authenticated on public.ag_negotiation_rules;
create policy ag_rules_select_authenticated on public.ag_negotiation_rules
  for select to authenticated
  using (public.current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists ag_tool_select_authenticated on public.ag_tool_calls;
create policy ag_tool_select_authenticated on public.ag_tool_calls
  for select to authenticated
  using (public.current_user_papel() = any (array['proprietario','colaborador']));

-- ── Item 9: grupos_economicos: equipe + o próprio grupo do cedente ────────────
drop policy if exists grupos_economicos_read_authed on public.grupos_economicos;
create policy grupos_economicos_read_authed on public.grupos_economicos
  for select to authenticated
  using (public.current_user_papel() = any (array['proprietario','colaborador'])
         or id = public.current_user_grupo_economico());

commit;
