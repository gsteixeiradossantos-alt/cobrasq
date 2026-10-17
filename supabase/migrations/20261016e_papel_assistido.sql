-- 2026-10-16 — adiciona o papel 'assistido' ao vínculo cobrança↔parte (cobranca_partes).
-- Assistido(a) = pessoa atendida/paciente que NÃO é devedora (ex.: filho atendido pelo
-- dentista; o responsável pelo pagamento é o devedor). O painel passa a excluí-lo de
-- cálculos, cobrança, régua/WhatsApp, totais de devedores e petições.
-- Definição anterior (2026-06-23_papel_sucessor.sql): emitente, endossante, avalista,
-- fiador, devedor_solidario, sucessor. Alargar o CHECK é retrocompatível (todos os valores
-- antigos seguem válidos). Idempotente: dropa e recria a constraint.
-- NÃO APLICADA — aplicar só com autorização do gestor, antes do merge do PR.

ALTER TABLE public.cobranca_partes DROP CONSTRAINT IF EXISTS cobranca_partes_papel_check;
ALTER TABLE public.cobranca_partes ADD CONSTRAINT cobranca_partes_papel_check
  CHECK (papel IN ('emitente','endossante','avalista','fiador','devedor_solidario','sucessor','assistido'));
