-- Seed das 4 audiências futuras já capturadas do Jus.br/PROJUDI (idempotente
-- via WHERE NOT EXISTS por numero_processo) + os 12 lembretes correspondentes
-- (3 por audiência: véspera 19h, dia 08h, 10min antes). Espelha o que já foi
-- inserido manualmente em produção em 2026-07-26.

INSERT INTO public.audiencias (numero_processo, comarca, orgao_julgador, tipo_audiencia, sala, data_hora, previsao_termino, partes, origem, created_by)
SELECT * FROM (VALUES
  (
    '6000045-27.2026.8.16.0079', 'Dois Vizinhos',
    'Juizado Especial Cível e Juizado Especial da Fazenda Pública de Dois Vizinhos',
    'Audiência de conciliação', 'Audiências de Conciliação - JEC',
    '2026-09-02 08:50:00-03'::timestamptz, '2026-09-02 09:00:00-03'::timestamptz,
    '[{"nome":"COBRASQ RECUPERADORA DE CREDITO E COBRANCA LTDA","papel":"AUTOR"},{"nome":"DEBORA REGINA IZE","papel":"REU"}]'::jsonb,
    'projudi_import', 'Sistema (import PROJUDI)'
  ),
  (
    '6000034-95.2026.8.16.0079', 'Dois Vizinhos',
    'Juizado Especial Cível e Juizado Especial da Fazenda Pública de Dois Vizinhos',
    'Audiência de conciliação', 'Audiências de Conciliação - JEC',
    '2026-09-08 08:30:00-03'::timestamptz, '2026-09-08 08:40:00-03'::timestamptz,
    '[{"nome":"PAULO EDSON PINTO DOS SANTOS","papel":"AUTOR"},{"nome":"SILVIA AZZOLIN DE OLIVEIRA SANTOS","papel":"AUTOR"},{"nome":"W E COMERCIO DE PISCINAS S/A","papel":"REU"}]'::jsonb,
    'projudi_import', 'Sistema (import PROJUDI)'
  ),
  (
    '6000074-77.2026.8.16.0079', 'Dois Vizinhos',
    'Juizado Especial Cível e Juizado Especial da Fazenda Pública de Dois Vizinhos',
    'Audiência de conciliação', 'Audiências de Conciliação - JEC',
    '2026-09-09 09:10:00-03'::timestamptz, '2026-09-09 09:20:00-03'::timestamptz,
    '[{"nome":"COBRASQ RECUPERADORA DE CREDITO E COBRANCA LTDA","papel":"AUTOR"},{"nome":"LUCIANO ALVES DE MEIRA","papel":"REU"}]'::jsonb,
    'projudi_import', 'Sistema (import PROJUDI)'
  ),
  (
    '6000215-94.2026.8.16.0209', 'Francisco Beltrão',
    'Juizado Especial Cível, Criminal e da Fazenda Pública de Francisco Beltrão',
    'Audiência de conciliação', 'JEC - Conciliação Thais',
    '2026-09-09 17:00:00-03'::timestamptz, '2026-09-09 17:10:00-03'::timestamptz,
    '[{"nome":"R PEREIRA VEICULOS LTDA","papel":"AUTOR"},{"nome":"TAINARA MANFRO","papel":"REU"},{"nome":"BRUNO MOTTA NETTO","papel":"REU"}]'::jsonb,
    'projudi_import', 'Sistema (import PROJUDI)'
  )
) AS v(numero_processo, comarca, orgao_julgador, tipo_audiencia, sala, data_hora, previsao_termino, partes, origem, created_by)
WHERE NOT EXISTS (
  SELECT 1 FROM public.audiencias existente WHERE existente.numero_processo = v.numero_processo
);

-- Lembretes (idempotente via WHERE NOT EXISTS por audiencia_id+origem).
WITH base AS (
  SELECT id, numero_processo, comarca, sala, data_hora, telefone_notificacao,
         (data_hora AT TIME ZONE 'America/Sao_Paulo')::date AS dia_local,
         (SELECT string_agg(p->>'nome', ', ') FROM jsonb_array_elements(partes) p WHERE p->>'papel'='REU') AS reus
  FROM public.audiencias
  WHERE origem = 'projudi_import'
)
INSERT INTO public.crm_mensagens_agendadas (audiencia_id, telefone, tipo, mensagem, agendada_para, status, origem)
SELECT
  b.id, b.telefone_notificacao, 'texto',
  CASE f.fase
    WHEN 'd1'    THEN '🔔 *Lembrete — audiência amanhã*' || E'\n' || 'Processo: ' || b.numero_processo || E'\n'
                       || to_char(b.data_hora AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY às HH24:MI') || ' — ' || b.comarca || ', sala: ' || b.sala || E'\n'
                       || 'Réu(s): ' || b.reus
    WHEN 'dia'   THEN '📅 *Hoje tem audiência*' || E'\n' || 'Processo: ' || b.numero_processo || E'\n'
                       || 'Às ' || to_char(b.data_hora AT TIME ZONE 'America/Sao_Paulo','HH24:MI') || ' — ' || b.comarca || ', sala: ' || b.sala || E'\n'
                       || 'Réu(s): ' || b.reus
    WHEN 'min10' THEN '⏰ *Audiência em 10 minutos*' || E'\n' || 'Processo: ' || b.numero_processo || E'\n'
                       || to_char(b.data_hora AT TIME ZONE 'America/Sao_Paulo','HH24:MI') || ' — ' || b.comarca || ', sala: ' || b.sala || E'\n'
                       || 'Réu(s): ' || b.reus
  END,
  CASE f.fase
    WHEN 'd1'    THEN ((b.dia_local - 1) + time '19:00') AT TIME ZONE 'America/Sao_Paulo'
    WHEN 'dia'   THEN (b.dia_local + time '08:00') AT TIME ZONE 'America/Sao_Paulo'
    WHEN 'min10' THEN b.data_hora - interval '10 minutes'
  END,
  'pendente',
  'audiencia_lembrete_' || f.fase
FROM base b CROSS JOIN (VALUES ('d1'),('dia'),('min10')) AS f(fase)
WHERE NOT EXISTS (
  SELECT 1 FROM public.crm_mensagens_agendadas existente
  WHERE existente.audiencia_id = b.id AND existente.origem = 'audiencia_lembrete_' || f.fase
);
