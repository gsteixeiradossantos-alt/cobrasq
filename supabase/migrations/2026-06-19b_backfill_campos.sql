-- ============================================================================
-- Separação Devedor ↔ Cobrança — FASE C (backfill de dados)
-- Popula as colunas criadas em 2026-06-19a a partir do que hoje vive em
-- metadata/divida jsonb. É uma CÓPIA idempotente: não apaga as origens
-- (metadata/divida/blob seguem intactos) → o rollback só re-anula as colunas.
-- ----------------------------------------------------------------------------
-- De/para (chaves verificadas no prod jokbxzhcctcwnbhkhgru em 2026-06-19):
--   cobrancas.numero_processo ← metadata.processoNum
--   cobrancas.vara_tribunal   ← metadata.vara
--   cobrancas.vencimento      ← metadata.vencimento | divida.vencimento | divida.dataVenc
--   cobrancas.tipo_documento  ← metadata.titulo | divida.descricao   (valor legado preservado)
--   cobrancas.observacoes     ← metadata.obs
--   cobrancas.tags            ← metadata.tags (jsonb array → text[])
--   devedores.data_nascimento ← metadata.loginNascimento
--   devedores.observacoes     ← metadata.obs
--   devedores.tags            ← metadata.tags (jsonb array → text[])
-- Campos novos sem origem (origem, numero_documento, banco, agencia_conta, rg,
--   nacionalidade, estado_civil, profissao, apelido) ficam NULL de propósito.
-- Usa public.safe_date (2026-06-11b) p/ cast text→date tolerante.
-- Só escreve onde a coluna está vazia (COALESCE / tags = '{}') → idempotente.
-- Aplicar via Supabase MCP após review. Rollback: 2026-06-19b_..._rollback.sql
-- ============================================================================

-- ── cobrancas: escalares ────────────────────────────────────────────────────
UPDATE public.cobrancas SET
  numero_processo = COALESCE(numero_processo, NULLIF(metadata->>'processoNum','')),
  vara_tribunal   = COALESCE(vara_tribunal,   NULLIF(metadata->>'vara','')),
  vencimento      = COALESCE(vencimento,
                             public.safe_date(metadata->>'vencimento'),
                             public.safe_date(divida->>'vencimento'),
                             public.safe_date(divida->>'dataVenc')),
  tipo_documento  = COALESCE(tipo_documento, NULLIF(metadata->>'titulo',''), NULLIF(divida->>'descricao','')),
  observacoes     = COALESCE(observacoes, NULLIF(metadata->>'obs',''))
WHERE jsonb_typeof(metadata) = 'object' OR jsonb_typeof(divida) = 'object';

-- ── cobrancas: tags (jsonb array → text[]) ──────────────────────────────────
UPDATE public.cobrancas SET
  tags = ARRAY(SELECT jsonb_array_elements_text(metadata->'tags'))
WHERE jsonb_typeof(metadata->'tags') = 'array'
  AND (metadata->'tags') <> '[]'::jsonb
  AND tags = '{}';

-- ── devedores: escalares ────────────────────────────────────────────────────
UPDATE public.devedores SET
  data_nascimento = COALESCE(data_nascimento, public.safe_date(metadata->>'loginNascimento')),
  observacoes     = COALESCE(observacoes, NULLIF(metadata->>'obs',''))
WHERE jsonb_typeof(metadata) = 'object';

-- ── devedores: tags (jsonb array → text[]) ──────────────────────────────────
UPDATE public.devedores SET
  tags = ARRAY(SELECT jsonb_array_elements_text(metadata->'tags'))
WHERE jsonb_typeof(metadata->'tags') = 'array'
  AND (metadata->'tags') <> '[]'::jsonb
  AND tags = '{}';
