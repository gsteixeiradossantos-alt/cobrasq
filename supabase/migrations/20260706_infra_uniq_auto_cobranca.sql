-- ============================================================
-- PREPARADA — NÃO APLICAR SEM REVISÃO
-- ============================================================
-- Trava anti-duplicidade da auto-cobrança / lembrete ZapSign.
--
-- Contexto: quando um acordo fica "Aguardando assinatura", o CRM agenda lembretes
-- automáticos em crm_mensagens_agendadas com um `origem` que identifica o ESTÁGIO do
-- lembrete daquele caso: 'auto_cobranca_24h' e 'auto_cobranca_48h'
-- (ver crm.html -> processarAutoCobrancaZapSign / agendarAutoCobranca).
--
-- Chave natural do lembrete = (caso_id, origem):
--   um caso deve ter, no máximo, UM lembrete de cada estágio (24h/48h).
-- O front já tenta evitar o duplo agendamento lendo o histórico do caso, mas essa
-- checagem é client-side e NÃO é atômica: dois disparos concorrentes de
-- processarAutoCobrancaZapSign (duas abas/dois operadores, ou um retry) podem passar os
-- dois pela checagem e inserir o MESMO lembrete duas vezes -> o devedor recebe a mesma
-- cobrança repetida. Este índice único fecha essa janela no banco.
--
-- O que a trava GARANTE: no máximo 1 linha em crm_mensagens_agendadas por
-- (caso_id, origem) enquanto origem começar com 'auto_cobranca'. Um segundo INSERT
-- concorrente com o mesmo par falha (unique_violation) em vez de duplicar o envio.
-- Índice PARCIAL: só cobre os lembretes automáticos; mensagens 'manual' (e futuras
-- origens sem essa semântica) NÃO são afetadas e podem repetir livremente.
--
-- Pré-checagem (rodada read-only na preparação, 2026-07-06): nenhuma duplicata
-- (caso_id, origem) existente — o índice pode ser criado sem limpeza prévia. Ainda assim,
-- se ao aplicar houver duplicata, rode antes o bloco de limpeza comentado no rollback.
--
-- APLICAR MANUALMENTE no SQL Editor do projeto jokbxzhcctcwnbhkhgru. Rollback em _rollback.sql.

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_msg_agendadas_auto_cobranca
  ON public.crm_mensagens_agendadas (caso_id, origem)
  WHERE origem LIKE 'auto_cobranca%';

COMMENT ON INDEX public.uq_crm_msg_agendadas_auto_cobranca IS
  'Anti-duplicidade: 1 lembrete automático por (caso_id, origem) — ex.: no máximo um auto_cobranca_24h e um auto_cobranca_48h por caso. Não cobre origem=manual.';
