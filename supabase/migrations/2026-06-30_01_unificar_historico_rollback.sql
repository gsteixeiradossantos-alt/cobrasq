-- Rollback de 2026-06-30_01_unificar_historico.sql
-- Remove os eventos curados do Adão e o índice. NÃO restaura o metadata.historico
-- cru (recarregável via cron/backfill DataJud se necessário).
DELETE FROM public.devedor_eventos
WHERE tipo='andamento_judicial' AND payload->>'fonte'='datajud'
  AND payload->>'dedup' LIKE '00046387520248160079:%';
DROP INDEX IF EXISTS public.uq_dev_eventos_datajud_dedup;
