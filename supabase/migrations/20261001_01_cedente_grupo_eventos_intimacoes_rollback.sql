-- Desfaz 20261001_01: o cedente por grupo volta a não ler histórico nem intimações.
DROP POLICY IF EXISTS eventos_cedente_grupo ON public.devedor_eventos;
DROP POLICY IF EXISTS intimacoes_cedente_grupo ON public.proc_intimacoes;
