-- Etapa 27: corrige vazamento de dados entre operadores.
-- As views abaixo rodavam como DEFINER (default), bypassando a RLS das
-- tabelas-fonte. Com security_invoker=true, a query roda no contexto do
-- usuário e respeita as policies de devedores/devedor_eventos/fin_*.
--
-- Antes deste fix: qualquer usuário autenticado (mesmo colaborador) via
-- TODOS os casos via from('casos') no CRM/Faturamento, porque a view
-- ignorava a policy devedores_colaborador_owned.
-- Depois: o WHERE da view passa pelo RLS de devedores → colaborador
-- só recebe casos onde cadastrado_por=auth.uid() OR assigned_to=auth.uid().

ALTER VIEW public.casos SET (security_invoker = true);
ALTER VIEW public.fin_custodia_judicial_alertas SET (security_invoker = true);

COMMENT ON VIEW public.casos IS
  'View sobre devedores + clientes + devedor_eventos. security_invoker=true pra herdar RLS de devedores (multi-tenant por cadastrado_por/assigned_to).';
