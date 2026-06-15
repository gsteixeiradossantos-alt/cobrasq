-- ============================================================================
-- Reestruturação Contatos + Cobranças (modelo Ástrea) — FASE A
-- Cobrança vira entidade própria, com múltiplos responsáveis (partes) + papéis.
-- Resolve: cheque com emitente + endossante (2 responsáveis) não cabia no modelo
-- devedor-cêntrico (dívida amarrada a 1 único devedor).
-- ----------------------------------------------------------------------------
-- ESTRATÉGIA INCREMENTAL: cada devedor existente vira 1 cobrança com o MESMO id
--   (cobranca.id = devedor.id). Assim casos.id (usado pelo CRM) permanece estável
--   e os filhos legados (devedor_eventos/acordos/dev_dividas) seguem alinhados.
--   `devedores` passa a ser o CONTATO (pessoa); `cobrancas` carrega o débito.
-- ----------------------------------------------------------------------------
-- NÃO aplicado automaticamente. Aplicar via Supabase MCP/SQL Editor no projeto
--   jokbxzhcctcwnbhkhgru após review. Rollback pareado:
--   2026-06-15a_cobrancas_e_partes_rollback.sql
-- ============================================================================

-- ── 1) Tabela cobrancas (entidade de débito) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cobrancas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id          UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
  status              TEXT,
  fase                TEXT,
  valor_orig          NUMERIC(14,2),
  valor_atual         NUMERIC(14,2),
  data_entrada        DATE,
  divida              JSONB DEFAULT '{}'::jsonb,
  metadata            JSONB DEFAULT '{}'::jsonb,
  passo_atual         TEXT,
  aguardando_resposta BOOLEAN DEFAULT false,
  encerramento        TIMESTAMPTZ,
  acordo_final        JSONB,
  etapa_atualizada_em TIMESTAMPTZ,
  encaminhamento_judicial TEXT,
  objecao_adicionais  JSONB,
  mesa_gestor         JSONB,
  checklist_judicial  JSONB,
  tipo_cobranca       TEXT DEFAULT 'digital',
  arquivado           BOOLEAN DEFAULT false,
  arquivado_em        TIMESTAMPTZ,
  arquivado_motivo    TEXT,
  is_draft            BOOLEAN DEFAULT false,
  draft_expires_at    TIMESTAMPTZ,
  assigned_to         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  cadastrado_por      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cobrancas_cliente        ON public.cobrancas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_cobrancas_cadastrado_por ON public.cobrancas(cadastrado_por);
CREATE INDEX IF NOT EXISTS idx_cobrancas_assigned_to    ON public.cobrancas(assigned_to);
CREATE INDEX IF NOT EXISTS idx_cobrancas_draft          ON public.cobrancas(is_draft) WHERE is_draft = true;

COMMENT ON TABLE public.cobrancas IS 'Cobrança/dívida como entidade própria (modelo Ástrea). Responsáveis em cobranca_partes. Migrada 1:1 de devedores (id compartilhado nos legados).';

-- ── 2) Tabela cobranca_partes (responsáveis com papel) ──────────────────────
CREATE TABLE IF NOT EXISTS public.cobranca_partes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cobranca_id UUID NOT NULL REFERENCES public.cobrancas(id) ON DELETE CASCADE,
  devedor_id  UUID NOT NULL REFERENCES public.devedores(id) ON DELETE CASCADE,
  papel       TEXT NOT NULL DEFAULT 'emitente'
              CHECK (papel IN ('emitente','endossante','avalista','fiador','devedor_solidario')),
  principal   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cobranca_partes_cobranca ON public.cobranca_partes(cobranca_id);
CREATE INDEX IF NOT EXISTS idx_cobranca_partes_devedor  ON public.cobranca_partes(devedor_id);
-- Sem responsável duplicado (mesmo papel) na mesma cobrança:
CREATE UNIQUE INDEX IF NOT EXISTS uq_cobranca_partes_papel
  ON public.cobranca_partes(cobranca_id, devedor_id, papel);
-- No máximo 1 parte principal por cobrança:
CREATE UNIQUE INDEX IF NOT EXISTS uq_cobranca_partes_principal
  ON public.cobranca_partes(cobranca_id) WHERE principal;

COMMENT ON TABLE public.cobranca_partes IS 'Responsáveis de uma cobrança (N por cobrança), com papel: emitente/endossante/avalista/fiador/devedor_solidario. Resolve cheque com 2 responsáveis.';

-- ── 3) cobranca_id nos filhos do caso (chave passa a ser a cobrança) ─────────
ALTER TABLE public.devedor_eventos
  ADD COLUMN IF NOT EXISTS cobranca_id UUID REFERENCES public.cobrancas(id) ON DELETE CASCADE;
ALTER TABLE public.acordos
  ADD COLUMN IF NOT EXISTS cobranca_id UUID REFERENCES public.cobrancas(id) ON DELETE CASCADE;
ALTER TABLE public.dev_dividas
  ADD COLUMN IF NOT EXISTS cobranca_id UUID REFERENCES public.cobrancas(id) ON DELETE CASCADE;

-- ── 4) MIGRAÇÃO DE DADOS — 1 devedor → 1 cobrança (mesmo id) ─────────────────
INSERT INTO public.cobrancas (
  id, cliente_id, status, fase, valor_orig, valor_atual, data_entrada,
  divida, metadata, passo_atual, aguardando_resposta, encerramento, acordo_final,
  etapa_atualizada_em, encaminhamento_judicial, objecao_adicionais, mesa_gestor,
  checklist_judicial, tipo_cobranca, arquivado, arquivado_em, arquivado_motivo,
  is_draft, draft_expires_at, assigned_to, cadastrado_por, created_at, updated_at
)
SELECT
  d.id, d.cliente_id, d.status, d.fase, d.valor_orig, d.valor_atual, d.data_entrada,
  COALESCE(d.divida, '{}'::jsonb), COALESCE(d.metadata, '{}'::jsonb), d.passo_atual,
  d.aguardando_resposta, d.encerramento, d.acordo_final,
  d.etapa_atualizada_em, d.encaminhamento_judicial, d.objecao_adicionais, d.mesa_gestor,
  d.checklist_judicial, COALESCE(d.tipo_cobranca, 'digital'), d.arquivado, d.arquivado_em,
  d.arquivado_motivo, d.is_draft, d.draft_expires_at, d.assigned_to, d.cadastrado_por,
  d.created_at, d.updated_at
FROM public.devedores d
ON CONFLICT (id) DO NOTHING;

-- Parte principal = o próprio devedor migrado, papel 'emitente'.
INSERT INTO public.cobranca_partes (cobranca_id, devedor_id, papel, principal)
SELECT co.id, co.id, 'emitente', true
FROM public.cobrancas co
ON CONFLICT (cobranca_id, devedor_id, papel) DO NOTHING;

-- Backfill cobranca_id nos filhos (ids alinhados nos legados).
UPDATE public.devedor_eventos e SET cobranca_id = e.devedor_id
  WHERE e.cobranca_id IS NULL
    AND EXISTS (SELECT 1 FROM public.cobrancas c WHERE c.id = e.devedor_id);
UPDATE public.acordos a SET cobranca_id = a.devedor_id
  WHERE a.cobranca_id IS NULL
    AND EXISTS (SELECT 1 FROM public.cobrancas c WHERE c.id = a.devedor_id);
UPDATE public.dev_dividas dd SET cobranca_id = dd.devedor_id
  WHERE dd.cobranca_id IS NULL
    AND EXISTS (SELECT 1 FROM public.cobrancas c WHERE c.id = dd.devedor_id);

-- ── 5) Default cadastrado_por + updated_at (reusa trigger genérico) ──────────
DROP TRIGGER IF EXISTS cobrancas_set_cadastrado_por ON public.cobrancas;
CREATE TRIGGER cobrancas_set_cadastrado_por
  BEFORE INSERT ON public.cobrancas
  FOR EACH ROW EXECUTE FUNCTION public.fn_default_cadastrado_por();

-- ── 6) RLS multi-tenant (espelha devedores) ─────────────────────────────────
ALTER TABLE public.cobrancas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cobrancas_proprietario_all ON public.cobrancas;
CREATE POLICY cobrancas_proprietario_all ON public.cobrancas
  FOR ALL
  USING (current_user_papel() = 'proprietario')
  WITH CHECK (current_user_papel() = 'proprietario');

DROP POLICY IF EXISTS cobrancas_colaborador_owned ON public.cobrancas;
CREATE POLICY cobrancas_colaborador_owned ON public.cobrancas
  FOR ALL
  USING (
    current_user_papel() = 'colaborador'
    AND (cadastrado_por = auth.uid() OR assigned_to = auth.uid())
  )
  WITH CHECK (
    current_user_papel() = 'colaborador'
    AND (cadastrado_por = auth.uid() OR assigned_to = auth.uid())
  );

ALTER TABLE public.cobranca_partes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cobranca_partes_proprietario_all ON public.cobranca_partes;
CREATE POLICY cobranca_partes_proprietario_all ON public.cobranca_partes
  FOR ALL
  USING (current_user_papel() = 'proprietario')
  WITH CHECK (current_user_papel() = 'proprietario');

DROP POLICY IF EXISTS cobranca_partes_colaborador_owned ON public.cobranca_partes;
CREATE POLICY cobranca_partes_colaborador_owned ON public.cobranca_partes
  FOR ALL
  USING (
    current_user_papel() = 'colaborador'
    AND cobranca_id IN (
      SELECT id FROM public.cobrancas
      WHERE cadastrado_por = auth.uid() OR assigned_to = auth.uid()
    )
  )
  WITH CHECK (
    current_user_papel() = 'colaborador'
    AND cobranca_id IN (
      SELECT id FROM public.cobrancas
      WHERE cadastrado_por = auth.uid() OR assigned_to = auth.uid()
    )
  );
