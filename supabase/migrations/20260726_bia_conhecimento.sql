-- JÁ APLICADO EM PROD (versão 20260726142747). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Base de conhecimento da Bia: regras de negócio, respostas-modelo, glossário
-- e erros conhecidos, editáveis sem deploy (o worker monta o prompt lendo as
-- linhas ativas por categoria/ordem). Grants = defaults do schema; leitura via
-- RLS para staff (proprietário + colaborador), escrita só service_role/backend
-- (nenhuma policy de escrita → RLS bloqueia INSERT/UPDATE/DELETE de clientes).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bia_conhecimento (
  slug          text PRIMARY KEY,
  categoria     text NOT NULL,
  titulo        text NOT NULL,
  conteudo      text NOT NULL,
  ordem         integer NOT NULL DEFAULT 100,
  ativo         boolean NOT NULL DEFAULT true,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bia_conhecimento_categoria_check
    CHECK (categoria = ANY (ARRAY['regra_negocio'::text, 'resposta_modelo'::text, 'glossario'::text, 'erro_conhecido'::text]))
);

CREATE INDEX IF NOT EXISTS idx_bia_conhecimento_ativo
  ON public.bia_conhecimento USING btree (categoria, ordem) WHERE ativo;

ALTER TABLE public.bia_conhecimento ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bia_conhecimento_staff ON public.bia_conhecimento;
CREATE POLICY bia_conhecimento_staff ON public.bia_conhecimento
  FOR SELECT
  USING (current_user_papel() = ANY (ARRAY['proprietario'::text, 'colaborador'::text]));
