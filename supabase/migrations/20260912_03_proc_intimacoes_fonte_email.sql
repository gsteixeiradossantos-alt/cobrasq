-- ============================================================================
-- 20260912_03 — proc_intimacoes aceita fonte 'email' e 'djen' (+ backfill)
-- ----------------------------------------------------------------------------
-- O worker email-intimacoes (07/2026) e o botão "Vincular" da fila (ivVincular)
-- gravam cada ato vinculado também em proc_intimacoes com fonte='email' — é o
-- que alimenta a aba "Andamentos" e o badge de não-lidas. Mas o CHECK de `fonte`
-- (20260510_06 + 2026-06-23a) só aceita escavador/jusbrasil/codilo/datajud/
-- manual: o INSERT falha, o código trata como best-effort e ninguém vê. Em
-- 12/09/2026: 328 atos de e-mail vinculados, 0 em proc_intimacoes (R-27).
--
-- Aqui: amplia o CHECK ('email' e 'djen', este p/ a aba "Só no diário" da
-- 20260912_02) e faz o backfill dos 328 como lida=true — histórico antigo não
-- vira 328 alertas de uma vez (mesma regra da primeira sincronização do
-- cron-datajud). Daqui em diante os novos entram como lida=false, como sempre
-- foi a intenção. Aditiva; rollback pareado.
-- ============================================================================

begin;

ALTER TABLE public.proc_intimacoes DROP CONSTRAINT IF EXISTS proc_intimacoes_fonte_check;
ALTER TABLE public.proc_intimacoes
  ADD CONSTRAINT proc_intimacoes_fonte_check
  CHECK (fonte IN ('escavador','jusbrasil','codilo','datajud','manual','email','djen'));

-- Backfill: mesmo payload que o worker grava (dedup_key = 'email:' || dedup).
-- proc_intimacoes.devedor_id tem FK para devedores; 19 das 328 vinculadas
-- apontam para cobrança SEM linha em devedores (dual-write, CLAUDE.md) — ficam
-- de fora (o worker também falharia nelas pela FK, não pelo CHECK).
INSERT INTO public.proc_intimacoes
  (fonte, processo_num, data_publicacao, data_intimacao, conteudo, devedor_id, lida, dedup_key, created_at)
SELECT 'email', e.numero_processo, e.data_ato, e.data_ato, coalesce(e.ato_curado, e.ato),
       e.cobranca_id, true, 'email:' || e.dedup, e.criado_em
  FROM public.intimacoes_email e
 WHERE e.status = 'vinculada'
   AND e.cobranca_id IS NOT NULL
   AND e.dedup IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.devedores d WHERE d.id = e.cobranca_id)
ON CONFLICT (dedup_key) DO NOTHING;

commit;
