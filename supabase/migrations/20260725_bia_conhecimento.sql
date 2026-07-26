-- ============================================================
-- Base de conhecimento da Bia: fonte que bia-atendimento consulta
-- em runtime (espelho de docs/bia/*.md, sincronizado via
-- scripts/sync-bia-knowledge.js). Editar os .md, não a tabela.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bia_conhecimento (
  slug          text PRIMARY KEY,
  categoria     text NOT NULL CHECK (categoria IN ('regra_negocio','resposta_modelo','glossario','erro_conhecido')),
  titulo        text NOT NULL,
  conteudo      text NOT NULL,
  ordem         int NOT NULL DEFAULT 100,
  ativo         boolean NOT NULL DEFAULT true,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bia_conhecimento IS 'Base de conhecimento da Bia (regras de negócio, respostas-modelo, glossário, erros conhecidos). Fonte editável: docs/bia/*.md no git, sincronizada via scripts/sync-bia-knowledge.js. bia-atendimento injeta categoria=regra_negocio no prompt em runtime; as demais categorias são só referência.';

CREATE INDEX IF NOT EXISTS idx_bia_conhecimento_ativo ON public.bia_conhecimento(categoria, ordem) WHERE ativo;

ALTER TABLE public.bia_conhecimento ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bia_conhecimento_staff ON public.bia_conhecimento;
CREATE POLICY bia_conhecimento_staff ON public.bia_conhecimento
  FOR SELECT USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
