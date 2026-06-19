-- ============================================================================
-- Separação Devedor ↔ Cobrança — FASE C (campos)
-- Completa a separação iniciada em 2026-06-15a/b (cobrancas + cobranca_partes):
-- a DÍVIDA deixa de viver no devedor. Aqui só ADICIONAMOS colunas (aditivo,
-- reversível) e DEPRECIAMOS (sem DROP) as colunas de dívida de `devedores`.
--   • cobrancas: campos de dívida que hoje vivem em divida/metadata jsonb
--     (judicial, vencimento, tags, documento) viram colunas próprias.
--   • devedores: ficha pura + "Qualificação p/ petição"
--     (rg, nacionalidade, estado civil, profissão, apelido, nascimento, obs, tags).
--   • Depreciação: COMMENT marca as colunas de dívida de `devedores` como
--     legadas/somente-leitura. Fonte única do débito passa a ser `cobrancas`.
-- ----------------------------------------------------------------------------
-- INVARIANTE preservada (2026-06-15): cobranca.id = id do devedor PRINCIPAL =
--   caso.id. Esta migração NÃO mexe em chaves, dados ou na view `casos`.
-- ----------------------------------------------------------------------------
-- Colunas novas são NULL/aditivas → NÃO quebram o app atual (que ainda não as lê)
--   nem a view `casos` (CREATE OR REPLACE preserva). Sem reescrita de tabela:
--   DEFAULT '{}' em text[] é constante (metadata-only no PG 11+).
-- Aplicar via Supabase MCP/SQL Editor no projeto jokbxzhcctcwnbhkhgru após review
--   (não rodar `supabase db push` cego — ver CLAUDE.md). Rollback pareado:
--   2026-06-19a_cobrancas_devedores_campos_rollback.sql
-- ============================================================================

-- ── 1) cobrancas: campos de dívida promovidos de jsonb a colunas ────────────
ALTER TABLE public.cobrancas
  ADD COLUMN IF NOT EXISTS numero_processo  TEXT,
  ADD COLUMN IF NOT EXISTS vara_tribunal    TEXT,
  ADD COLUMN IF NOT EXISTS vencimento       DATE,
  ADD COLUMN IF NOT EXISTS tags             TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tipo_documento   TEXT,
  ADD COLUMN IF NOT EXISTS numero_documento TEXT,
  ADD COLUMN IF NOT EXISTS banco            TEXT,
  ADD COLUMN IF NOT EXISTS agencia_conta    TEXT,
  ADD COLUMN IF NOT EXISTS origem           TEXT,
  ADD COLUMN IF NOT EXISTS observacoes      TEXT;

COMMENT ON COLUMN public.cobrancas.numero_processo  IS 'Fase/Etapa judicial (antes em devedores.metadata.processoNum).';
COMMENT ON COLUMN public.cobrancas.vara_tribunal    IS 'Fase/Etapa judicial (antes em devedores.metadata.vara).';
COMMENT ON COLUMN public.cobrancas.vencimento       IS 'Vencimento do título (antes em divida->>vencimento).';
COMMENT ON COLUMN public.cobrancas.tipo_documento   IS 'Cheque, Nota promissória, Confissão de dívida, Contrato, Duplicata, Boleto/fatura, Nota fiscal, Conversa no WhatsApp, Outro.';
COMMENT ON COLUMN public.cobrancas.tags             IS 'Tags do caso (antes em devedores.metadata.tags).';

-- ── 2) devedores: ficha pura + qualificação p/ petição ──────────────────────
ALTER TABLE public.devedores
  ADD COLUMN IF NOT EXISTS rg              TEXT,
  ADD COLUMN IF NOT EXISTS nacionalidade   TEXT,
  ADD COLUMN IF NOT EXISTS estado_civil    TEXT,
  ADD COLUMN IF NOT EXISTS profissao       TEXT,
  ADD COLUMN IF NOT EXISTS apelido         TEXT,
  ADD COLUMN IF NOT EXISTS data_nascimento DATE,
  ADD COLUMN IF NOT EXISTS observacoes     TEXT,
  ADD COLUMN IF NOT EXISTS tags            TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.devedores.rg            IS 'Qualificação p/ petição inicial.';
COMMENT ON COLUMN public.devedores.nacionalidade IS 'Qualificação p/ petição inicial.';
COMMENT ON COLUMN public.devedores.estado_civil  IS 'Qualificação p/ petição inicial.';
COMMENT ON COLUMN public.devedores.profissao     IS 'Qualificação p/ petição inicial.';

-- ── 3) Depreciação (SEM DROP) das colunas de dívida em devedores ────────────
-- Fonte única do débito passa a ser `cobrancas`. Estas colunas viram legadas
-- (somente-leitura) e serão removidas numa migração POSTERIOR, após burn-in.
-- A view `casos` já lê o débito de `cobrancas` (2026-06-15b); o cliente para de
-- escrevê-las na Etapa D (devedorToRow / salvarDevedor).
DO $$
DECLARE
  col TEXT;
  msg CONSTANT TEXT :=
    'DEPRECATED 2026-06-19: dívida migrou para public.cobrancas (fonte única). '
    'Coluna legada/somente-leitura; será removida após burn-in. NÃO escrever pelo cliente.';
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
      EXECUTE format('COMMENT ON COLUMN public.devedores.%I IS %L', col, msg);
    END IF;
  END LOOP;
END $$;
