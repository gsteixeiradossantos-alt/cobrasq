-- Rollback de 20261016_portal_dados_sensiveis.sql
-- Recria as policies exatamente como estavam em produção em 16/10/2026 (geradas de
-- pg_policies naquele dia) e apaga as funções novas. NÃO rodar sem motivo: devolve ao
-- cliente pagamentos/atrasos do Asaas e os campos internos de devedores/cobrancas.

begin;

drop policy if exists acordos_cedente_read on public.acordos;
create policy acordos_cedente_read on public.acordos as PERMISSIVE for SELECT to authenticated
  using ((devedor_id IN ( SELECT d.id
   FROM (devedores d
     JOIN clientes c ON ((c.id = d.cliente_id)))
  WHERE (c.app_user_id = auth.uid()))));

drop policy if exists ag_config_select_authenticated on public.ag_config;
create policy ag_config_select_authenticated on public.ag_config as PERMISSIVE for SELECT to authenticated
  using (true);

drop policy if exists ag_consents_select_authenticated on public.ag_consents;
create policy ag_consents_select_authenticated on public.ag_consents as PERMISSIVE for SELECT to authenticated
  using (true);

drop policy if exists ag_kb_select_authenticated on public.ag_kb_chunks;
create policy ag_kb_select_authenticated on public.ag_kb_chunks as PERMISSIVE for SELECT to authenticated
  using (true);

drop policy if exists ag_msg_select_authenticated on public.ag_messages;
create policy ag_msg_select_authenticated on public.ag_messages as PERMISSIVE for SELECT to authenticated
  using (true);

drop policy if exists ag_rules_select_authenticated on public.ag_negotiation_rules;
create policy ag_rules_select_authenticated on public.ag_negotiation_rules as PERMISSIVE for SELECT to authenticated
  using (true);

drop policy if exists ag_tool_select_authenticated on public.ag_tool_calls;
create policy ag_tool_select_authenticated on public.ag_tool_calls as PERMISSIVE for SELECT to authenticated
  using (true);

drop policy if exists alertas_vinculo_leitura on public.alertas_vinculo;
create policy alertas_vinculo_leitura on public.alertas_vinculo as PERMISSIVE for SELECT to authenticated
  using (true);

drop policy if exists cobranca_partes_cedente_grupo on public.cobranca_partes;
create policy cobranca_partes_cedente_grupo on public.cobranca_partes as PERMISSIVE for SELECT to authenticated
  using ((cobranca_id IN ( SELECT c.id
   FROM cobrancas c
  WHERE (((current_user_grupo_economico() IS NOT NULL) AND (c.cliente_id IN ( SELECT clientes.id
           FROM clientes
          WHERE (clientes.grupo_economico_id = current_user_grupo_economico())))) OR ((current_user_grupo() IS NOT NULL) AND (c.cliente_id IN ( SELECT clientes.id
           FROM clientes
          WHERE ((clientes.cliente_grupo_id = current_user_grupo()) OR (clientes.id = current_user_grupo())))))))));

drop policy if exists cobranca_partes_cedente_scope on public.cobranca_partes;
create policy cobranca_partes_cedente_scope on public.cobranca_partes as PERMISSIVE for SELECT to authenticated
  using ((cobranca_id IN ( SELECT c.id
   FROM cobrancas c
  WHERE (c.cliente_id IN ( SELECT clientes.id
           FROM clientes
          WHERE (clientes.app_user_id = auth.uid()))))));

drop policy if exists cobranca_terceiros_cedente_grupo on public.cobranca_terceiros;
create policy cobranca_terceiros_cedente_grupo on public.cobranca_terceiros as PERMISSIVE for SELECT to authenticated
  using ((cobranca_id IN ( SELECT c.id
   FROM cobrancas c
  WHERE (((current_user_grupo_economico() IS NOT NULL) AND (c.cliente_id IN ( SELECT clientes.id
           FROM clientes
          WHERE (clientes.grupo_economico_id = current_user_grupo_economico())))) OR ((current_user_grupo() IS NOT NULL) AND (c.cliente_id IN ( SELECT clientes.id
           FROM clientes
          WHERE ((clientes.cliente_grupo_id = current_user_grupo()) OR (clientes.id = current_user_grupo())))))))));

drop policy if exists cobranca_terceiros_cedente_scope on public.cobranca_terceiros;
create policy cobranca_terceiros_cedente_scope on public.cobranca_terceiros as PERMISSIVE for SELECT to authenticated
  using ((cobranca_id IN ( SELECT c.id
   FROM cobrancas c
  WHERE (c.cliente_id IN ( SELECT clientes.id
           FROM clientes
          WHERE (clientes.app_user_id = auth.uid()))))));

drop policy if exists cobrancas_cedente_grupo on public.cobrancas;
create policy cobrancas_cedente_grupo on public.cobrancas as PERMISSIVE for SELECT to authenticated
  using ((((current_user_grupo_economico() IS NOT NULL) AND (cliente_id IN ( SELECT clientes.id
   FROM clientes
  WHERE (clientes.grupo_economico_id = current_user_grupo_economico())))) OR ((current_user_grupo() IS NOT NULL) AND (cliente_id IN ( SELECT clientes.id
   FROM clientes
  WHERE ((clientes.cliente_grupo_id = current_user_grupo()) OR (clientes.id = current_user_grupo())))))));

drop policy if exists cobrancas_cedente_scope on public.cobrancas;
create policy cobrancas_cedente_scope on public.cobrancas as PERMISSIVE for SELECT to authenticated
  using ((cliente_id IN ( SELECT clientes.id
   FROM clientes
  WHERE (clientes.app_user_id = auth.uid()))));

drop policy if exists eventos_cedente_grupo on public.devedor_eventos;
create policy eventos_cedente_grupo on public.devedor_eventos as PERMISSIVE for SELECT to authenticated
  using ((((tipo = ANY (ARRAY['andamento_judicial'::text, 'asaas_pagamento_recebido'::text, 'asaas_pagamento_atrasado'::text, 'asaas_boletos_emitidos'::text, 'zapsign_assinado'::text, 'acordo_assinado_confirmado'::text, 'acordo_concluido_auto'::text, 'acordo_cancelado'::text, 'acordo_descumprido'::text, 'caso_criado'::text, 'repasse'::text])) OR ((tipo = ANY (ARRAY['nota_manual'::text, 'nota'::text, 'anotacao'::text, 'historico_legacy'::text, 'mudanca_status'::text])) AND (((payload ->> 'visivel_cliente'::text) = 'true'::text) OR ((payload ->> 'visivelCliente'::text) = 'true'::text)))) AND (((cobranca_id IS NOT NULL) AND (cobranca_id IN ( SELECT cb.id
   FROM (cobrancas cb
     JOIN clientes c ON ((c.id = cb.cliente_id)))
  WHERE (((current_user_grupo_economico() IS NOT NULL) AND (c.grupo_economico_id = current_user_grupo_economico())) OR ((current_user_grupo() IS NOT NULL) AND ((c.cliente_grupo_id = current_user_grupo()) OR (c.id = current_user_grupo()))))))) OR ((cobranca_id IS NULL) AND (devedor_id IN ( SELECT d.id
   FROM (devedores d
     JOIN clientes c ON ((c.id = d.cliente_id)))
  WHERE (((current_user_grupo_economico() IS NOT NULL) AND (c.grupo_economico_id = current_user_grupo_economico())) OR ((current_user_grupo() IS NOT NULL) AND ((c.cliente_grupo_id = current_user_grupo()) OR (c.id = current_user_grupo()))))))))));

drop policy if exists eventos_cedente_read on public.devedor_eventos;
create policy eventos_cedente_read on public.devedor_eventos as PERMISSIVE for SELECT to authenticated
  using ((((tipo = ANY (ARRAY['andamento_judicial'::text, 'asaas_pagamento_recebido'::text, 'asaas_pagamento_atrasado'::text, 'asaas_boletos_emitidos'::text, 'zapsign_assinado'::text, 'acordo_assinado_confirmado'::text, 'acordo_concluido_auto'::text, 'acordo_cancelado'::text, 'acordo_descumprido'::text, 'caso_criado'::text, 'repasse'::text])) OR ((tipo = ANY (ARRAY['nota_manual'::text, 'nota'::text, 'anotacao'::text, 'historico_legacy'::text, 'mudanca_status'::text])) AND (((payload ->> 'visivel_cliente'::text) = 'true'::text) OR ((payload ->> 'visivelCliente'::text) = 'true'::text)))) AND (((cobranca_id IS NOT NULL) AND (cobranca_id IN ( SELECT cb.id
   FROM (cobrancas cb
     JOIN clientes c ON ((c.id = cb.cliente_id)))
  WHERE (c.app_user_id = auth.uid())))) OR ((cobranca_id IS NULL) AND (devedor_id IN ( SELECT d.id
   FROM (devedores d
     JOIN clientes c ON ((c.id = d.cliente_id)))
  WHERE (c.app_user_id = auth.uid())))))));

drop policy if exists devedores_cedente_grupo on public.devedores;
create policy devedores_cedente_grupo on public.devedores as PERMISSIVE for SELECT to authenticated
  using ((((current_user_grupo_economico() IS NOT NULL) AND (cliente_id IN ( SELECT clientes.id
   FROM clientes
  WHERE (clientes.grupo_economico_id = current_user_grupo_economico())))) OR ((current_user_grupo() IS NOT NULL) AND (cliente_id IN ( SELECT clientes.id
   FROM clientes
  WHERE ((clientes.cliente_grupo_id = current_user_grupo()) OR (clientes.id = current_user_grupo())))))));

drop policy if exists devedores_cedente_parte on public.devedores;
create policy devedores_cedente_parte on public.devedores as PERMISSIVE for SELECT to authenticated
  using ((id IN ( SELECT p.devedor_id
   FROM (cobranca_partes p
     JOIN cobrancas c ON ((c.id = p.cobranca_id)))
  WHERE (c.cliente_id IN ( SELECT clientes.id
           FROM clientes
          WHERE (clientes.app_user_id = auth.uid())
        UNION
         SELECT clientes.id
           FROM clientes
          WHERE ((current_user_grupo_economico() IS NOT NULL) AND (clientes.grupo_economico_id = current_user_grupo_economico()))
        UNION
         SELECT clientes.id
           FROM clientes
          WHERE ((current_user_grupo() IS NOT NULL) AND ((clientes.cliente_grupo_id = current_user_grupo()) OR (clientes.id = current_user_grupo()))))))));

drop policy if exists devedores_cedente_scope on public.devedores;
create policy devedores_cedente_scope on public.devedores as PERMISSIVE for SELECT to authenticated
  using ((cliente_id IN ( SELECT clientes.id
   FROM clientes
  WHERE (clientes.app_user_id = auth.uid()))));

drop policy if exists documentos_cedente_grupo on public.documentos;
create policy documentos_cedente_grupo on public.documentos as PERMISSIVE for SELECT to authenticated
  using ((((categoria = 'repasse'::text) AND (cobranca_id IN ( SELECT (c.id)::text AS id
   FROM cobrancas c
  WHERE (c.cliente_id IN ( SELECT cl.id
           FROM clientes cl
          WHERE (((current_user_grupo_economico() IS NOT NULL) AND (cl.grupo_economico_id = current_user_grupo_economico())) OR ((current_user_grupo() IS NOT NULL) AND ((cl.cliente_grupo_id = current_user_grupo()) OR (cl.id = current_user_grupo()))))))))) OR (id IN ( SELECT r.documento_id
   FROM repasses_cliente r
  WHERE ((r.documento_id IS NOT NULL) AND (r.cliente_id IN ( SELECT cl.id
           FROM clientes cl
          WHERE (((current_user_grupo_economico() IS NOT NULL) AND (cl.grupo_economico_id = current_user_grupo_economico())) OR ((current_user_grupo() IS NOT NULL) AND ((cl.cliente_grupo_id = current_user_grupo()) OR (cl.id = current_user_grupo())))))))))));

drop policy if exists documentos_cedente_scope on public.documentos;
create policy documentos_cedente_scope on public.documentos as PERMISSIVE for SELECT to authenticated
  using (((cobranca_id IN ( SELECT (c.id)::text AS id
   FROM cobrancas c
  WHERE (c.cliente_id IN ( SELECT clientes.id
           FROM clientes
          WHERE (clientes.app_user_id = auth.uid()))))) AND ((categoria = 'repasse'::text) OR (id IN ( SELECT r.documento_id
   FROM repasses_cliente r
  WHERE ((r.documento_id IS NOT NULL) AND (r.cliente_id IN ( SELECT clientes.id
           FROM clientes
          WHERE (clientes.app_user_id = auth.uid())))))))));

drop policy if exists grupos_economicos_read_authed on public.grupos_economicos;
create policy grupos_economicos_read_authed on public.grupos_economicos as PERMISSIVE for SELECT to authenticated
  using (true);

drop policy if exists provas_cedente_read on public.peticao_provas;
create policy provas_cedente_read on public.peticao_provas as PERMISSIVE for SELECT to public
  using ((devedor_id IN ( SELECT d.id
   FROM (devedores d
     JOIN clientes c ON ((c.id = d.cliente_id)))
  WHERE (c.app_user_id = auth.uid()))));

drop policy if exists intimacoes_cedente_grupo on public.proc_intimacoes;
create policy intimacoes_cedente_grupo on public.proc_intimacoes as PERMISSIVE for SELECT to authenticated
  using (((devedor_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (devedores d
     JOIN clientes c ON ((c.id = d.cliente_id)))
  WHERE ((d.id = proc_intimacoes.devedor_id) AND (((current_user_grupo_economico() IS NOT NULL) AND (c.grupo_economico_id = current_user_grupo_economico())) OR ((current_user_grupo() IS NOT NULL) AND ((c.cliente_grupo_id = current_user_grupo()) OR (c.id = current_user_grupo())))))))));

drop policy if exists intimacoes_cedente_select on public.proc_intimacoes;
create policy intimacoes_cedente_select on public.proc_intimacoes as PERMISSIVE for SELECT to authenticated
  using (((devedor_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (devedores d
     JOIN clientes c ON ((c.id = d.cliente_id)))
  WHERE ((d.id = proc_intimacoes.devedor_id) AND (c.app_user_id = auth.uid()))))));

drop policy if exists documentos_cedente_grupo_select on storage.objects;
create policy documentos_cedente_grupo_select on storage.objects as PERMISSIVE for SELECT to authenticated
  using (((bucket_id = 'documentos'::text) AND (EXISTS ( SELECT 1
   FROM ((documentos d
     JOIN cobrancas c ON (((c.id)::text = d.cobranca_id)))
     JOIN clientes cl ON ((cl.id = c.cliente_id)))
  WHERE ((d.storage_path = objects.name) AND (((current_user_grupo_economico() IS NOT NULL) AND (cl.grupo_economico_id = current_user_grupo_economico())) OR ((current_user_grupo() IS NOT NULL) AND ((cl.cliente_grupo_id = current_user_grupo()) OR (cl.id = current_user_grupo())))) AND ((d.categoria = 'repasse'::text) OR (d.id IN ( SELECT r.documento_id
           FROM repasses_cliente r
          WHERE ((r.documento_id IS NOT NULL) AND (r.cliente_id = cl.id))))))))));

drop policy if exists documentos_cedente_select on storage.objects;
create policy documentos_cedente_select on storage.objects as PERMISSIVE for SELECT to authenticated
  using (((bucket_id = 'documentos'::text) AND (EXISTS ( SELECT 1
   FROM ((documentos d
     JOIN cobrancas c ON (((c.id)::text = d.cobranca_id)))
     JOIN clientes cl ON ((cl.id = c.cliente_id)))
  WHERE ((d.storage_path = objects.name) AND (cl.app_user_id = auth.uid()) AND ((d.categoria = 'repasse'::text) OR (d.id IN ( SELECT r.documento_id
           FROM repasses_cliente r
          WHERE ((r.documento_id IS NOT NULL) AND (r.cliente_id = cl.id))))))))));

-- Funções novas (nenhuma policy restaurada acima depende delas)
drop function if exists public.portal_cobrancas();
drop function if exists public.portal_devedores();
drop function if exists public._portal_hist(jsonb);
drop function if exists public.cedente_devedor_ids();
drop function if exists public.cedente_cobranca_ids();
drop function if exists public.cedente_cliente_ids();

commit;
