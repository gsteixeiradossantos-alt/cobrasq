-- Rollback de 20260708_devedores_cedente_parte.sql
-- Remove só a policy nova (as policies existentes de cedente permanecem).
-- Os índices idx_cobranca_partes_* / idx_cobrancas_cliente são deixados (inofensivos).
drop policy if exists devedores_cedente_parte on public.devedores;
