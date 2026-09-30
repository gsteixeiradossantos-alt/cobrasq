-- ============================================================================
-- Normaliza numero_parcela / total_parcelas em fin_lancamento a partir do texto
-- ----------------------------------------------------------------------------
-- Levantamento em 12/08/2026 (886 linhas na tabela):
--
--   864  trazem " N/M" no fim de `descricao`
--   154  têm `numero_parcela` preenchido
--   717  têm o TEXTO e NÃO têm a coluna   <- alvo desta migração
--     3  têm os dois e DIVERGEM           <- preservados, ver abaixo
--     7  têm a coluna e não têm o texto   <- não tocados
--   144  já estão coerentes               <- não tocados
--
-- Consequência prática do buraco: qualquer código que agrupe parcelas pelas
-- COLUNAS enxerga só 17% dos parcelamentos. Foi o que obrigou a exclusão em
-- cascata (PR #510) a derivar a série do texto.
--
-- POR QUE AS 3 DIVERGENTES FICAM COMO ESTÃO
-- São reparcelamentos, em que o texto numera o acordo inteiro e a coluna numera
-- o parcelamento vigente:
--
--   id 123784  "Fernanda da Silva 11/16"            coluna  6/10
--   id 123790  "Larissa Cristina Borges Ternus 7/9" coluna  3/5
--   id 123802  "Valery Verona Alécio 14/17"         coluna 12/15
--
-- Não há como saber daqui qual das duas numerações é a "certa" — são
-- informações diferentes, não uma errada. Sobrescrever a coluna com o texto
-- destruiria o dado do parcelamento vigente. O WHERE exige `numero_parcela IS
-- NULL`, então elas nem entram.
--
-- SEGURANÇA
--  - Idempotente: rodar de novo não altera mais nada (o WHERE exige NULL).
--  - Só escreve onde o texto casa o padrão e é coerente (n >= 1, m >= n).
--  - Não toca `descricao`: o texto continua sendo a fonte, a coluna vira espelho.
--  - Efeito colateral conhecido: o trigger `trg_fin_lancamento_touch` vai mexer
--    em `atualizada_em` das linhas afetadas. Conferido em 12/08/2026 que essa
--    coluna não é lida por nenhuma tela (index.html, crm.html, api/, functions)
--    — é só carimbo de auditoria.
--  - Rollback pareado: 20260812_normaliza_numero_parcela_rollback.sql
--    (a tabela de backup criada aqui é o que torna o rollback exato).
-- ============================================================================

BEGIN;

-- 1) Backup do estado anterior — só das linhas que serão tocadas.
--    É o que permite desfazer exatamente, sem depender de PITR.
CREATE TABLE IF NOT EXISTS public._bkp_numero_parcela_20260812 (
  id               BIGINT PRIMARY KEY,
  numero_parcela   INTEGER,
  total_parcelas   INTEGER,
  descricao        TEXT,
  atualizada_em    TIMESTAMPTZ,
  salvo_em         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public._bkp_numero_parcela_20260812 (id, numero_parcela, total_parcelas, descricao, atualizada_em)
SELECT l.id, l.numero_parcela, l.total_parcelas, l.descricao, l.atualizada_em
FROM public.fin_lancamento l
WHERE l.numero_parcela IS NULL
  AND l.descricao ~ ' [0-9]+/[0-9]+$'
  AND (regexp_match(l.descricao, ' ([0-9]+)/([0-9]+)$'))[1]::int >= 1
  AND (regexp_match(l.descricao, ' ([0-9]+)/([0-9]+)$'))[2]::int
      >= (regexp_match(l.descricao, ' ([0-9]+)/([0-9]+)$'))[1]::int
ON CONFLICT (id) DO NOTHING;

-- 2) Preenche as colunas a partir do texto.
UPDATE public.fin_lancamento l
SET numero_parcela = (regexp_match(l.descricao, ' ([0-9]+)/([0-9]+)$'))[1]::int,
    total_parcelas = (regexp_match(l.descricao, ' ([0-9]+)/([0-9]+)$'))[2]::int
WHERE l.numero_parcela IS NULL
  AND l.descricao ~ ' [0-9]+/[0-9]+$'
  AND (regexp_match(l.descricao, ' ([0-9]+)/([0-9]+)$'))[1]::int >= 1
  AND (regexp_match(l.descricao, ' ([0-9]+)/([0-9]+)$'))[2]::int
      >= (regexp_match(l.descricao, ' ([0-9]+)/([0-9]+)$'))[1]::int;

-- 3) Conferência dentro da própria transação — aborta se algo não bater.
DO $$
DECLARE
  v_restantes  INT;
  v_incoerente INT;
  v_divergente INT;
BEGIN
  -- nenhuma linha com texto válido pode continuar sem coluna
  SELECT count(*) INTO v_restantes
  FROM public.fin_lancamento
  WHERE numero_parcela IS NULL AND descricao ~ ' [0-9]+/[0-9]+$';
  IF v_restantes > 0 THEN
    RAISE EXCEPTION 'Sobraram % linhas com texto de parcela e coluna vazia', v_restantes;
  END IF;

  -- nenhuma linha pode ficar com numero > total
  SELECT count(*) INTO v_incoerente
  FROM public.fin_lancamento
  WHERE numero_parcela IS NOT NULL AND total_parcelas IS NOT NULL
    AND (numero_parcela < 1 OR numero_parcela > total_parcelas);
  IF v_incoerente > 0 THEN
    RAISE EXCEPTION 'Ficaram % linhas com numero_parcela incoerente', v_incoerente;
  END IF;

  -- as 3 divergentes conhecidas têm de continuar divergentes (não sobrescritas)
  SELECT count(*) INTO v_divergente
  FROM public.fin_lancamento
  WHERE id IN (123784, 123790, 123802)
    AND numero_parcela IS DISTINCT FROM (regexp_match(descricao, ' ([0-9]+)/([0-9]+)$'))[1]::int;
  IF v_divergente <> 3 THEN
    RAISE EXCEPTION 'As 3 linhas de reparcelamento deveriam seguir divergentes, mas % seguem', v_divergente;
  END IF;

  RAISE NOTICE 'OK — colunas preenchidas, 3 reparcelamentos preservados.';
END $$;

COMMIT;

-- Conferência pós-aplicação (rodar solto, fora da transação):
--
--   SELECT count(*) FILTER (WHERE numero_parcela IS NOT NULL) AS com_coluna,
--          count(*) FILTER (WHERE descricao ~ ' [0-9]+/[0-9]+$') AS com_texto,
--          count(*) AS total
--   FROM public.fin_lancamento;
--   -- esperado: com_coluna = 871, com_texto = 864, total = 886
--   -- (871 = 154 que já tinham + 717 preenchidas)
--
-- Números conferidos por dry-run contra produção em 12/08/2026: a migração
-- inteira foi executada dentro de uma transação e revertida com ROLLBACK,
-- medindo 717 linhas afetadas, 0 sobrando sem coluna, 0 incoerentes e os 3
-- reparcelamentos preservados.
