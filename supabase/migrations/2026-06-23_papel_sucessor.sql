-- 2026-06-23 — Handoff §2: adiciona o papel 'sucessor' ao vínculo cobrança↔devedor.
-- O CHECK original (2026-06-15a_cobrancas_e_partes.sql) não previa 'Sucessor', listado
-- no spec entre os papéis possíveis (Emitente · Endossante · Avalista · Fiador ·
-- Devedor solidário · Sucessor). Alargar o CHECK é retrocompatível (todos os valores
-- antigos seguem válidos). Idempotente: dropa e recria a constraint.

ALTER TABLE public.cobranca_partes DROP CONSTRAINT IF EXISTS cobranca_partes_papel_check;
ALTER TABLE public.cobranca_partes ADD CONSTRAINT cobranca_partes_papel_check
  CHECK (papel IN ('emitente','endossante','avalista','fiador','devedor_solidario','sucessor'));
