-- 20260930_01 — Corrige o rótulo dos andamentos DataJud de código TPU 51.
--
-- NÃO APLICADA. Aplicar em produção só com autorização explícita do Gustavo.
--
-- O código 51 da TPU/CNJ é "Conclusão" (autos conclusos ao juiz; pai 48, conferido
-- em gateway.cloud.pje.jus.br/tpu, versão 2025-09-11), mas api/_datajud-tpu.js o
-- rotulava "Penhora/constrição de bens". O cron não reescreve evento já gravado
-- (pré-check por payload.dedup), então o código corrigido só vale para andamento
-- novo; os antigos precisam deste UPDATE.
--
-- Em 30/09/2026: 961 eventos em 218 cobranças, todos tipo andamento_judicial.
-- Só troca payload.acao_completa; codigo, nome, data e dedup ficam intactos.

-- Conferência antes (esperado em 30/09/2026: 961 | 218)
select count(*) as eventos, count(distinct cobranca_id) as cobrancas
  from public.devedor_eventos
 where tipo = 'andamento_judicial'
   and payload->>'fonte' = 'datajud'
   and payload->>'codigo' = '51'
   and payload->>'acao_completa' = 'Penhora/constrição de bens';

begin;

update public.devedor_eventos
   set payload = jsonb_set(payload, '{acao_completa}', to_jsonb('Conclusos'::text))
 where tipo = 'andamento_judicial'
   and payload->>'fonte' = 'datajud'
   and payload->>'codigo' = '51'
   and payload->>'acao_completa' = 'Penhora/constrição de bens';

-- Conferência depois (esperado: 0)
select count(*) as restantes
  from public.devedor_eventos
 where payload->>'fonte' = 'datajud'
   and payload->>'codigo' = '51'
   and payload->>'acao_completa' ilike 'Penhora%';

commit;

-- Rollback (se precisar desfazer):
-- update public.devedor_eventos
--    set payload = jsonb_set(payload, '{acao_completa}', to_jsonb('Penhora/constrição de bens'::text))
--  where tipo = 'andamento_judicial' and payload->>'fonte' = 'datajud'
--    and payload->>'codigo' = '51' and payload->>'acao_completa' = 'Conclusos';
