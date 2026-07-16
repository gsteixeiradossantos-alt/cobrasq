-- 20260709_casos_fora_crm
-- Flag "fora do CRM": o caso permanece em cobrancas (editavel no Faturamento) mas some da
-- view casos (CRM). Nao e arquivamento nem encerramento. Usada para: judicial ja protocolado,
-- acordo assinado, casos concluidos e acordos firmados fora.

ALTER TABLE public.cobrancas
  ADD COLUMN IF NOT EXISTS fora_crm BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.cobrancas.fora_crm IS
  'Caso ja em andamento/concluido (judicial protocolado, acordo assinado, concluido, acordo externo). Permanece em cobrancas, editavel no Faturamento; so e ocultado da view casos (CRM). Nao e arquivamento nem encerramento.';

CREATE INDEX IF NOT EXISTS idx_cobrancas_fora_crm
  ON public.cobrancas(fora_crm) WHERE fora_crm = true;

-- Recria a view casos anexando o filtro fora_crm ao WHERE existente (idempotente, mesmo padrao
-- de 20260619_fix_casos_view_exclude_drafts.sql).
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  IF position('fora_crm' in def) = 0 THEN
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS '
            || def || E'\n  AND NOT COALESCE(co.fora_crm, false)';
  END IF;
END $$;
