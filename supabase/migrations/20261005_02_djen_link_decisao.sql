-- 20261005_02 — link público da decisão nos itens do DJEN que já estão na timeline.
-- Só DADOS (sem DDL). Os itens novos já nascem com o link pela edge function
-- djen-intimacoes; esta migração cobre os que entraram antes dela.
-- Link = certidão do DJEN (https://comunicaapi.pje.jus.br/api/v1/comunicacao/<hash>/certidao):
-- PDF com o teor, sem login nem captcha.
-- Idempotente: só toca evento sem link_decisao.

UPDATE public.devedor_eventos e
   SET payload = e.payload || jsonb_build_object(
         'link_decisao', 'https://comunicaapi.pje.jus.br/api/v1/comunicacao/' || d.hash_djen || '/certidao')
  FROM public.intimacoes_djen d
 WHERE e.payload->>'fonte' = 'djen'
   AND e.payload->>'dedup' = 'djen:' || d.dedup
   AND d.hash_djen IS NOT NULL
   AND NOT (e.payload ? 'link_decisao');
