-- 2026-06-30_01_unificar_historico.sql
-- Unifica a timeline do caso em devedor_eventos: andamentos judiciais CURADOS
-- (filtrados + rótulos amigáveis) passam a ser gravados pelo cron-datajud em
-- devedor_eventos (tipo='andamento_judicial'), lidos pelo CRM e pelo portal do
-- cedente (eventos_cedente_read). Ver api/_datajud-tpu.js.

-- 1) Idempotência do cron: índice único parcial pela chave de dedup do datajud.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dev_eventos_datajud_dedup
  ON public.devedor_eventos ((payload->>'dedup'))
  WHERE tipo = 'andamento_judicial' AND payload->>'fonte' = 'datajud';

-- 2) Backfill do caso Adão Elias da Silva (subconjunto curado dos 24 andamentos
--    já carregados). Idempotente via ON CONFLICT no índice acima.
INSERT INTO public.devedor_eventos (devedor_id, cobranca_id, tipo, payload, criado_em) VALUES
  ('e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'andamento_judicial','{"acao_completa": "Petição protocolada", "fonte": "datajud", "data": "2024-08-22", "codigo": "85", "nome": "Petição", "dedup": "00046387520248160079:85:2024-08-22T15:16:03.000Z"}'::jsonb,'2024-08-22T12:00:00Z'::timestamptz),
  ('e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'andamento_judicial','{"acao_completa": "Ação distribuída (protocolada)", "fonte": "datajud", "data": "2024-08-22", "codigo": "26", "nome": "Distribuição", "dedup": "00046387520248160079:26:2024-08-22T15:16:03.000Z"}'::jsonb,'2024-08-22T12:00:00Z'::timestamptz),
  ('e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'andamento_judicial','{"acao_completa": "Audiência de conciliação — designada", "fonte": "datajud", "data": "2024-08-23", "codigo": "12740", "nome": "de Conciliação", "dedup": "00046387520248160079:12740:2024-08-23T13:05:28.000Z"}'::jsonb,'2024-08-23T12:00:00Z'::timestamptz),
  ('e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'andamento_judicial','{"acao_completa": "Mandado — entregue ao destinatário", "fonte": "datajud", "data": "2025-02-13", "codigo": "106", "nome": "Mandado", "dedup": "00046387520248160079:106:2025-02-13T12:46:52.000Z"}'::jsonb,'2025-02-13T12:00:00Z'::timestamptz),
  ('e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'andamento_judicial','{"acao_completa": "Audiência de conciliação — realizada", "fonte": "datajud", "data": "2025-04-15", "codigo": "12740", "nome": "de Conciliação", "dedup": "00046387520248160079:12740:2025-04-15T11:19:34.000Z"}'::jsonb,'2025-04-15T12:00:00Z'::timestamptz),
  ('e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'andamento_judicial','{"acao_completa": "Trânsito em julgado", "fonte": "datajud", "data": "2025-05-19", "codigo": "848", "nome": "Trânsito em julgado", "dedup": "00046387520248160079:848:2025-05-19T13:33:31.000Z"}'::jsonb,'2025-05-19T12:00:00Z'::timestamptz),
  ('e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'andamento_judicial','{"acao_completa": "Arquivamento definitivo", "fonte": "datajud", "data": "2025-05-28", "codigo": "246", "nome": "Definitivo", "dedup": "00046387520248160079:246:2025-05-28T15:53:15.000Z"}'::jsonb,'2025-05-28T12:00:00Z'::timestamptz),
  ('e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'e1dec331-6382-4504-9933-0a9a4bf23126'::uuid,'andamento_judicial','{"acao_completa": "Petição protocolada", "fonte": "datajud", "data": "2025-12-01", "codigo": "85", "nome": "Petição", "dedup": "00046387520248160079:85:2025-12-01T16:52:04.000Z"}'::jsonb,'2025-12-01T12:00:00Z'::timestamptz)
ON CONFLICT ((payload->>'dedup')) WHERE (tipo='andamento_judicial' AND payload->>'fonte'='datajud') DO NOTHING;

-- 3) Remove o despejo CRU de datajud do metadata.historico do Adão (agora vem de
--    devedor_eventos, curado — evita duplicar na timeline).
UPDATE public.devedores d
SET metadata = jsonb_set(
  d.metadata,
  '{historico}',
  COALESCE((
    SELECT jsonb_agg(h)
    FROM jsonb_array_elements(COALESCE(d.metadata->'historico','[]'::jsonb)) h
    WHERE COALESCE(h->>'fonte','') <> 'datajud'
  ), '[]'::jsonb)
)
WHERE d.id = 'e1dec331-6382-4504-9933-0a9a4bf23126'::uuid
  AND d.metadata ? 'historico';
