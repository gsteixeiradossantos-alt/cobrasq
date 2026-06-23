-- ============================================================================
-- proc_peticionamentos — fila de peticionamento no eproc (Fase 2 eproc)
-- ----------------------------------------------------------------------------
-- Contexto: a extensão Chrome (Opção B) protocola petições no eproc TJPR dentro
--   da sessão logada do advogado. Esta tabela é a FILA/auditoria desses jobs:
--   o app cria a linha (status 'preparado') a partir de uma petição já gerada
--   (peticao_geradas / bucket documentos) + número do processo + tipo/evento; a
--   extensão consome via api/eproc-peticionamento.js e reporta o resultado.
-- ----------------------------------------------------------------------------
-- RLS multi-tenant espelha public.cobrancas (2026-06-15a): proprietário vê tudo;
--   colaborador vê só os próprios (owner_id). O endpoint ainda lê com o token do
--   usuário (RLS aplicada), nunca service-role, então a extensão só enxerga os
--   jobs do próprio usuário.
-- ----------------------------------------------------------------------------
-- Aditivo. NÃO rodar `supabase db push` cego (ver CLAUDE.md): aplicar via SQL
--   Editor no projeto jokbxzhcctcwnbhkhgru após review. Rollback pareado:
--   2026-06-23b_peticionamentos_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.proc_peticionamentos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cobranca_id       UUID REFERENCES public.cobrancas(id) ON DELETE CASCADE,
  devedor_id        UUID REFERENCES public.devedores(id) ON DELETE SET NULL,
  numero_processo   TEXT,
  tipo              TEXT NOT NULL DEFAULT 'intercorrente'
                    CHECK (tipo IN ('inicial','intercorrente')),
  evento_eproc      TEXT,                 -- código/descrição do tipo de petição no eproc
  pdf_path          TEXT,                 -- storage_path no bucket 'documentos'
  peticao_gerada_id UUID REFERENCES public.peticao_geradas(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'preparado'
                    CHECK (status IN ('preparado','enviando','protocolado','erro','cancelado')),
  protocolo_num     TEXT,
  protocolado_em    TIMESTAMPTZ,
  erro              TEXT,
  owner_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_peticionamentos_cobranca ON public.proc_peticionamentos(cobranca_id);
CREATE INDEX IF NOT EXISTS idx_peticionamentos_owner    ON public.proc_peticionamentos(owner_id);
CREATE INDEX IF NOT EXISTS idx_peticionamentos_status   ON public.proc_peticionamentos(status);

COMMENT ON TABLE public.proc_peticionamentos IS
  'Fila/auditoria de peticionamento no eproc TJPR (Fase 2). App cria preparado; extensão protocola e reporta.';

-- ── Default owner_id + updated_at (reusa triggers genéricos se existirem) ─────
-- owner_id default = usuário autenticado (igual padrão de outras tabelas).
ALTER TABLE public.proc_peticionamentos ALTER COLUMN owner_id SET DEFAULT auth.uid();

-- ── RLS multi-tenant (espelha cobrancas) ─────────────────────────────────────
ALTER TABLE public.proc_peticionamentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS peticionamentos_proprietario_all ON public.proc_peticionamentos;
CREATE POLICY peticionamentos_proprietario_all ON public.proc_peticionamentos
  FOR ALL
  USING (public.current_user_papel() = 'proprietario')
  WITH CHECK (public.current_user_papel() = 'proprietario');

DROP POLICY IF EXISTS peticionamentos_colaborador_owned ON public.proc_peticionamentos;
CREATE POLICY peticionamentos_colaborador_owned ON public.proc_peticionamentos
  FOR ALL
  USING (public.current_user_papel() = 'colaborador' AND owner_id = auth.uid())
  WITH CHECK (public.current_user_papel() = 'colaborador' AND owner_id = auth.uid());
