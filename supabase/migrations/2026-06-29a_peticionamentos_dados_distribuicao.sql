-- ============================================================================
-- proc_peticionamentos.dados_distribuicao — payload da distribuição inicial (eproc)
-- ----------------------------------------------------------------------------
-- Contexto: para o peticionamento INICIAL (distribuição de ação nova no eproc TJPR),
--   a extensão precisa preencher as 5 etapas do assistente (Informações do processo,
--   Assuntos, Partes requerentes/requeridos, Documentos). Esta coluna guarda um
--   SNAPSHOT dos dados necessários, montado no app no momento de "Preparar
--   peticionamento" a partir do caso vinculado (credor=requerente, devedor=requerido,
--   valor) + classificação informada (comarca, rito, área, classe, assuntos, sigilo).
--   O endpoint api/_eproc-peticionamento entrega esse JSON à extensão.
--   Formato (flexível, validado no cliente/extensão):
--     { valor_causa, comarca, rito, area, classe, nivel_sigilo,
--       assuntos: [text...], requerentes: [{nome,doc}], requeridos: [{nome,doc,principal}] }
--   Nulo para peticionamento intercorrente (que não distribui).
-- ----------------------------------------------------------------------------
-- Aditivo e reversível. NÃO rodar `supabase db push` cego (ver CLAUDE.md): aplicar
--   via Supabase MCP/SQL Editor no projeto jokbxzhcctcwnbhkhgru após review.
--   Rollback pareado: 2026-06-29a_peticionamentos_dados_distribuicao_rollback.sql
-- ============================================================================

ALTER TABLE public.proc_peticionamentos
  ADD COLUMN IF NOT EXISTS dados_distribuicao JSONB;

COMMENT ON COLUMN public.proc_peticionamentos.dados_distribuicao IS
  'Snapshot dos dados da distribuição inicial (partes, valor, comarca, classe, assuntos...) para a extensão preencher as 5 etapas do eproc. NULL no intercorrente.';
