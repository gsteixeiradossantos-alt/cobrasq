-- 20260805_cobrancas_limpa_monitorar_sem_processo
--
-- LIMPEZA PONTUAL de dados, achada na auditoria de 05/08/2026: existem cobrancas com
-- monitorar_datajud = true mas SEM numero_processo preenchido -- ou seja, marcadas para
-- monitoramento do DataJud/CNJ sem ter processo pra consultar. Origem provavel: o form de
-- cobranca em index.html liga monitorar_datajud=true por padrao ja na CRIACAO da cobranca
-- (antes de ela virar judicial e ganhar numero de processo) -- a propria UI documenta isso
-- ("consulta diaria se houver no de processo"), entao a flag fica ligada cedo demais e so
-- nao gera efeito porque o cron confia num filtro a jusante.
--
-- A DEFESA PERMANENTE contra o desperdicio de chamada de API e o filtro adicionado a
-- query do cron em api/cron-datajud.js (numero_processo=not.is.null + numero_processo=neq.,
-- alem do numero_processo=not.is.null que ja existia) -- essa migracao NAO substitui aquele
-- fix, ela so limpa o ESTADO ATUAL dos dados (89 cobrancas confirmadas via SELECT em
-- producao em 05/08/2026) para tirar o ruido de flags ligadas sem processo associado.
--
-- Confirmado por SELECT em producao (projeto jokbxzhcctcwnbhkhgru), 05/08/2026:
--   select count(*) from cobrancas
--   where coalesce(monitorar_datajud,false)
--     and nullif(btrim(coalesce(numero_processo,'')),'') is null;
--   -> 89 (todas com numero_processo estritamente NULL, nenhuma vazia/so espaco)
--
-- NAO APLICADA AUTOMATICAMENTE. Aplicar manualmente via SQL Editor do Supabase ou
-- `supabase db push`, mediante autorizacao explicita do Gustavo (mudanca de dado em
-- producao e gated).

UPDATE public.cobrancas
SET monitorar_datajud = false
WHERE coalesce(monitorar_datajud,false)
  AND nullif(btrim(coalesce(numero_processo,'')),'') IS NULL;
