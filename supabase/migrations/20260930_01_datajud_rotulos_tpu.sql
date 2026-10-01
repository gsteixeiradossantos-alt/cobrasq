-- 20260930_01 — Corrige o rótulo de andamentos DataJud gravados com o nome errado.
--
-- Aplicar só com autorização do Gustavo (dada em 30/09/2026, depois do merge do PR #858).
--
-- Conferido na TPU/CNJ (gateway.cloud.pje.jus.br/tpu, versão 2025-09-11):
--   51  "Conclusão"                       — estava "Penhora/constrição de bens"
--   466 "Homologação de Transação"        — estava "Processo suspenso"
--   893 "Desarquivamento"                 — estava "Processo arquivado"
--   898 "Por decisão judicial" (Suspensão) — estava "Decisão proferida"
-- O cron não reescreve evento já gravado (pré-check por payload.dedup): o código
-- corrigido vale só para andamento novo; os antigos precisam deste UPDATE.
-- Só troca payload.acao_completa; codigo, nome, data e dedup ficam intactos.

-- Conferência antes (30/09/2026: 51=961/218, 466=52/45, 893=10/9, 898=22/15)
select payload->>'codigo' as codigo, count(*) as eventos, count(distinct cobranca_id) as cobrancas
  from public.devedor_eventos d
  join (values ('51','Penhora/constrição de bens'), ('466','Processo suspenso'),
               ('893','Processo arquivado'), ('898','Decisão proferida')) v(cod, antigo)
    on d.payload->>'codigo' = v.cod and d.payload->>'acao_completa' = v.antigo
 where d.tipo = 'andamento_judicial' and d.payload->>'fonte' = 'datajud'
 group by 1 order by 1;

begin;

update public.devedor_eventos d
   set payload = jsonb_set(d.payload, '{acao_completa}', to_jsonb(v.novo))
  from (values ('51',  'Penhora/constrição de bens', 'Conclusos'),
               ('466', 'Processo suspenso',          'Acordo homologado'),
               ('893', 'Processo arquivado',         'Processo desarquivado'),
               ('898', 'Decisão proferida',          'Processo suspenso por decisão judicial')
       ) v(cod, antigo, novo)
 where d.tipo = 'andamento_judicial'
   and d.payload->>'fonte' = 'datajud'
   and d.payload->>'codigo' = v.cod
   and d.payload->>'acao_completa' = v.antigo;

commit;

-- Rollback: a mesma tabela de valores com antigo/novo invertidos.
