-- ============================================================================
-- ROLLBACK de 2026-06-19a_cobrancas_devedores_campos.sql
-- Remove as colunas aditivas e limpa os COMMENTs de depreciação.
-- Não-destrutivo do dado original: os valores seguem vivos em
--   devedores.metadata / cobrancas.divida / blob cobrasq_data (a Etapa B só
--   COPIA para as colunas novas; não apaga as origens).
-- Pré-condição p/ rodar sem perda: ainda NÃO ter dropado as colunas legadas de
--   dívida em devedores (isto aqui só desfaz a FASE C de campos).
-- ============================================================================

-- ── 1) devedores: remove colunas aditivas ───────────────────────────────────
ALTER TABLE public.devedores
  DROP COLUMN IF EXISTS rg,
  DROP COLUMN IF EXISTS nacionalidade,
  DROP COLUMN IF EXISTS estado_civil,
  DROP COLUMN IF EXISTS profissao,
  DROP COLUMN IF EXISTS apelido,
  DROP COLUMN IF EXISTS data_nascimento,
  DROP COLUMN IF EXISTS observacoes,
  DROP COLUMN IF EXISTS tags;

-- ── 2) cobrancas: remove colunas aditivas ───────────────────────────────────
ALTER TABLE public.cobrancas
  DROP COLUMN IF EXISTS numero_processo,
  DROP COLUMN IF EXISTS vara_tribunal,
  DROP COLUMN IF EXISTS vencimento,
  DROP COLUMN IF EXISTS tags,
  DROP COLUMN IF EXISTS tipo_documento,
  DROP COLUMN IF EXISTS numero_documento,
  DROP COLUMN IF EXISTS banco,
  DROP COLUMN IF EXISTS agencia_conta,
  DROP COLUMN IF EXISTS origem,
  DROP COLUMN IF EXISTS observacoes;

-- ── 3) Limpa os COMMENTs de depreciação das colunas de dívida em devedores ──
DO $$
DECLARE col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY[
    'status','fase','valor_orig','valor_atual','data_entrada','divida',
    'tipo_cobranca','passo_atual','aguardando_resposta','encerramento',
    'acordo_final','encaminhamento_judicial','etapa_atualizada_em',
    'objecao_adicionais','mesa_gestor','checklist_judicial'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'devedores' AND column_name = col
    ) THEN
      EXECUTE format('COMMENT ON COLUMN public.devedores.%I IS NULL', col);
    END IF;
  END LOOP;
END $$;
