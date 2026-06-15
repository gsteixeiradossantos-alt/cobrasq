-- ROLLBACK — FASE A (2026-06-15a_cobrancas_e_partes.sql)
-- Reverte tabelas/colunas da reestruturação Contatos + Cobranças.
-- ATENÇÃO: rode o rollback da FASE B (view casos sobre cobrancas) ANTES deste,
--   senão a view fica órfã. Dados em cobrancas/cobranca_partes são descartados.

DROP TRIGGER IF EXISTS cobrancas_set_cadastrado_por ON public.cobrancas;

ALTER TABLE public.devedor_eventos DROP COLUMN IF EXISTS cobranca_id;
ALTER TABLE public.acordos         DROP COLUMN IF EXISTS cobranca_id;
ALTER TABLE public.dev_dividas     DROP COLUMN IF EXISTS cobranca_id;

DROP TABLE IF EXISTS public.cobranca_partes;
DROP TABLE IF EXISTS public.cobrancas;
