-- ============================================================
-- Bia · Views de métricas e captura (Camadas 2 e 3)
-- ============================================================
-- Criadas em prod via execute_sql em 24/07/2026. Migração documenta no git.

-- Camada 3: métricas semanais de performance da Bia
CREATE OR REPLACE VIEW vw_bia_metricas_semanal AS
WITH semanas AS (
  SELECT
    date_trunc('week', l.enviada_em)::date as semana,
    l.acao,
    l.telefone,
    l.resposta
  FROM whatsapp_bia_log l
  WHERE l.enviada_em > now() - interval '90 days'
),
por_semana AS (
  SELECT
    semana,
    count(*) as total_acoes,
    count(*) filter (where acao = 'skip_nao_boleto') as skip_boleto,
    count(*) filter (where acao = 'skip_backlog') as skip_backlog,
    count(*) filter (where acao IN ('continuar','enviar_boleto','negociar_prazo','comprovante_enviado','comprovante_agendado','resolvido','ja_paguei','quer_comprovante','comprovante_efetuado')) as respondidas,
    count(*) filter (where acao = 'resolvido') as resolvidas,
    count(*) filter (where acao IN ('handoff','boleto_handoff','comprovante_handoff')) as handoffs,
    count(*) filter (where acao = 'silencio') as silencio,
    count(*) filter (where acao = 'ignorar') as ignoradas,
    count(*) filter (where acao = 'negociar_prazo') as prazos_negociados,
    count(*) filter (where acao = 'enviar_boleto') as boletos_enviados,
    count(distinct telefone) as contatos_unicos,
    count(*) filter (where resposta ilike '%desculpa%não%entend%') as loops_nao_entendi
  FROM semanas
  GROUP BY semana
)
SELECT
  semana,
  total_acoes,
  respondidas,
  resolvidas,
  handoffs,
  prazos_negociados,
  boletos_enviados,
  silencio,
  ignoradas,
  skip_boleto,
  skip_backlog,
  contatos_unicos,
  loops_nao_entendi,
  CASE WHEN respondidas > 0 THEN round(100.0 * resolvidas / respondidas, 1) ELSE 0 END as pct_resolucao,
  CASE WHEN respondidas > 0 THEN round(100.0 * handoffs / respondidas, 1) ELSE 0 END as pct_handoff,
  CASE WHEN respondidas > 0 THEN round(100.0 * loops_nao_entendi / respondidas, 1) ELSE 0 END as pct_loops
FROM por_semana
ORDER BY semana DESC;

-- Camada 2: respostas humanas capturadas (fromMe que não são da Bia)
CREATE OR REPLACE VIEW vw_bia_respostas_humanas AS
SELECT
  s.telefone_enviado as telefone,
  s.evento_em,
  coalesce(
    s.raw_payload->'text'->>'message',
    s.raw_payload->>'body',
    s.raw_payload->>'message'
  ) as texto_humano,
  a.intencao,
  a.estado,
  a.resumo as contexto_conversa
FROM crm_mensagens_status s
LEFT JOIN whatsapp_bia_enviadas b ON b.message_id = s.message_id
LEFT JOIN whatsapp_atendimentos a ON a.telefone = s.telefone_enviado
WHERE b.message_id IS NULL
  AND s.raw_payload IS NOT NULL
  AND s.raw_payload::text != '{}'
  AND coalesce(
    s.raw_payload->'text'->>'message',
    s.raw_payload->>'body',
    s.raw_payload->>'message',
    ''
  ) != ''
  AND length(coalesce(
    s.raw_payload->'text'->>'message',
    s.raw_payload->>'body',
    s.raw_payload->>'message',
    ''
  )) > 3
ORDER BY s.evento_em DESC;
