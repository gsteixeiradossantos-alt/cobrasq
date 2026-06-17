-- 20260617_07_clientes_doc_digits_unique.sql
-- ----------------------------------------------------------------------------
-- Trava de unicidade de CNPJ/CPF entre clientes (credores). Aplicado em prod via
-- MCP em 2026-06-17 (registro canônico). Pré-requisito: 20260617_06 (sem duplicados
-- ativos restantes — senão o índice falha ao ser criado).
--
-- Índice ÚNICO PARCIAL pelos dígitos do doc, apenas entre clientes ATIVOS e
-- não-rascunho com doc preenchido. Espelha findClientePorDoc() do app:
--   - ignora arquivados  -> permite re-cadastrar após arquivar;
--   - ignora rascunhos    -> rascunho não trava;
--   - ignora doc vazio    -> credor sem CNPJ não colide com outro sem CNPJ;
--   - NÃO atrapalha matriz/filial (CNPJs diferentes).
-- Qualquer escrita (modal, dual-write/flushRelational, import com doc) que tente
-- um 2º CNPJ ativo igual recebe 23505 (tratado com mensagem amigável no app).
--
-- Rollback: 20260617_07_clientes_doc_digits_unique_rollback.sql
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_doc_digits_unique
ON public.clientes ((regexp_replace(coalesce(doc,''),'\D','','g')))
WHERE coalesce(doc,'') <> ''
  AND regexp_replace(coalesce(doc,''),'\D','','g') <> ''
  AND NOT arquivado
  AND coalesce(is_draft,false) = false;
