-- ============================================================================
-- ROLLBACK de 20260812_normaliza_numero_parcela.sql
-- ----------------------------------------------------------------------------
-- Devolve numero_parcela / total_parcelas ao estado anterior usando a tabela de
-- backup criada pela migração. Restaura também `atualizada_em`, para que o
-- carimbo mexido pelo trigger não fique como cicatriz da operação.
--
-- Só desfaz o que a migração fez: linhas ausentes do backup não são tocadas.
-- Se alguém tiver editado uma dessas parcelas DEPOIS da migração, esta reversão
-- também apaga essa edição — por isso o aviso abaixo, que aborta quando detecta
-- alteração posterior.
-- ============================================================================

BEGIN;

-- Aborta se alguma linha do backup foi mexida depois da migração: nesse caso a
-- reversão cega destruiria trabalho novo, e a decisão passa a ser humana.
DO $$
DECLARE v_mexidas INT;
BEGIN
  SELECT count(*) INTO v_mexidas
  FROM public._bkp_numero_parcela_20260812 b
  JOIN public.fin_lancamento l ON l.id = b.id
  WHERE l.atualizada_em > b.salvo_em + interval '1 minute';
  IF v_mexidas > 0 THEN
    RAISE EXCEPTION
      '% linha(s) foram alteradas após a migração. Reverter apagaria essas mudanças — revise uma a uma antes de insistir.',
      v_mexidas;
  END IF;
END $$;

UPDATE public.fin_lancamento l
SET numero_parcela = b.numero_parcela,
    total_parcelas = b.total_parcelas,
    atualizada_em  = b.atualizada_em
FROM public._bkp_numero_parcela_20260812 b
WHERE l.id = b.id;

DO $$
DECLARE v_restantes INT;
BEGIN
  SELECT count(*) INTO v_restantes
  FROM public._bkp_numero_parcela_20260812 b
  JOIN public.fin_lancamento l ON l.id = b.id
  WHERE l.numero_parcela IS NOT NULL;
  IF v_restantes > 0 THEN
    RAISE EXCEPTION 'Reversão incompleta: % linha(s) seguem preenchidas', v_restantes;
  END IF;
  RAISE NOTICE 'OK — estado anterior restaurado.';
END $$;

COMMIT;

-- A tabela de backup é preservada de propósito. Descartar só depois de a
-- migração estar validada em produção por tempo suficiente:
--   DROP TABLE public._bkp_numero_parcela_20260812;
