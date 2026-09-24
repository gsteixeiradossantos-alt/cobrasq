-- 20260924f_drop_trigger_etapa_antigo
-- Autorizado pelo Gustavo em 24/09/2026.
--
-- Depois de 20260924c, DOIS gatilhos BEFORE INSERT/UPDATE gravavam `cobrancas.etapa`:
-- o antigo `trg_cobrancas_set_etapa` (funcao `cobrancas_set_etapa`, criada direto em
-- producao, fora de migrations) e o novo `trg_cobrancas_sync_etapa`. Eles discordavam
-- em 676 cobrancas — quem gravava por ultimo dependia da ordem alfabetica do nome do
-- trigger, o que e frágil e invisível na tela.
--
-- DUAS DIFERENCAS REAIS do antigo, e o que foi decidido sobre cada uma:
--
-- 1. Etapa 'travado' automatica: o antigo marcava 'travado' quando a cobranca ficava
--    90 dias sem evento novo. O Gustavo decidiu em 24/09/2026 NAO manter essa marcacao
--    automatica — etiqueta passa a ser so o que a equipe escrever. Por isso a regra
--    nao e reproduzida aqui.
--
-- 2. Manutencao de `etapa_atualizada_em`: essa o antigo fazia e continua sendo util,
--    entao e MOVIDA para `cobrancas_sync_etapa` antes do drop, para a coluna nao parar
--    de ser alimentada.
--
-- Tambem fixa `search_path` nas duas funcoes novas (advisor WARN
-- function_search_path_mutable).

CREATE OR REPLACE FUNCTION public.cobrancas_etapa_de_status(p_status text, p_processo text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $fn$
DECLARE s text := btrim(coalesce(p_status,'')); tem_proc boolean := btrim(coalesce(p_processo,'')) <> '';
BEGIN
  IF s = '' THEN RETURN 'cobrar'; END IF;
  IF s ~* '^quita\s*f[aá]cil' THEN RETURN 'quitafacil'; END IF;
  IF s ~* '^quitado ao cliente$' THEN
    RETURN CASE WHEN tem_proc THEN 'em_acao' ELSE 'cobrar' END;
  END IF;
  IF s ~* 'devolv'                        THEN RETURN 'devolvida'; END IF;
  IF s ~* 'quitad|pago|liquidad'          THEN RETURN 'quitado'; END IF;
  IF s ~* 'sem ?[êe]xito|baixad'          THEN RETURN 'encerrado'; END IF;
  IF s ~* 'executar\s+acordo'             THEN RETURN 'executar_acordo'; END IF;
  IF tem_proc AND s ~* 'cumprimento'      THEN RETURN 'cumprimento_sentenca'; END IF;
  IF tem_proc AND s ~* 'execu|penhora|hasta|expropria' THEN RETURN 'execucao'; END IF;
  IF s ~* 'reajuizar'                     THEN RETURN 'reajuizar'; END IF;
  IF s ~* 'corrigir\s+a[çc][ãa]o'         THEN RETURN 'corrigir_acao'; END IF;
  IF s ~* 'fazer\s+a[çc][ãa]o|para protocolar' THEN RETURN 'fazer_acao'; END IF;
  IF s ~* 'an[áa]lise'                    THEN RETURN 'analise'; END IF;
  IF s ~* 'acordo\s+enviado'              THEN RETURN 'negociando'; END IF;
  IF s ~* 'acordo'                        THEN RETURN 'acordo'; END IF;
  IF s ~* 'monit[óo]ria'                  THEN RETURN 'monitoria'; END IF;
  IF s ~* 'locupletamento'                THEN RETURN 'locupletamento'; END IF;
  IF tem_proc                             THEN RETURN 'em_acao'; END IF;
  IF s ~* 'negocia|proposta|em contato|contatad' THEN RETURN 'negociando'; END IF;
  IF s ~* 'telefone\s+inv[áa]lido'        THEN RETURN 'telefone_invalido'; END IF;
  IF s ~* 'encerrad'                      THEN RETURN 'encerrado'; END IF;
  RETURN 'cobrar';
END $fn$;

CREATE OR REPLACE FUNCTION public.cobrancas_sync_etapa()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $tg$
BEGIN
  NEW.etapa := public.cobrancas_etapa_de_status(NEW.status, NEW.numero_processo);
  -- herdado do trigger antigo (ver cabecalho): a coluna continua sendo alimentada.
  IF tg_op = 'UPDATE' AND NEW.etapa IS DISTINCT FROM OLD.etapa THEN
    NEW.etapa_atualizada_em := now();
  ELSIF tg_op = 'INSERT' THEN
    NEW.etapa_atualizada_em := coalesce(NEW.etapa_atualizada_em, now());
  END IF;
  RETURN NEW;
END $tg$;

DROP TRIGGER IF EXISTS trg_cobrancas_set_etapa ON public.cobrancas;
DROP FUNCTION IF EXISTS public.cobrancas_set_etapa();

-- Reconvergencia: nada mais escreve 'travado', entao as linhas que o antigo tinha
-- marcado assim voltam para a etapa derivada do proprio status.
UPDATE cobrancas
   SET etapa = public.cobrancas_etapa_de_status(status, numero_processo)
 WHERE etapa IS DISTINCT FROM public.cobrancas_etapa_de_status(status, numero_processo);
