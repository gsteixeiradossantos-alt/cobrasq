-- 20260924d_etapa_quitado_unificado
-- NÃO APLICADA (gated). Depende de 20260924c_cobrancas_etapa_trigger (a função e o
-- trigger precisam existir).
--
-- DECISÃO (Gustavo, 24/09/2026): o status "Quitado ao cliente" foi UNIFICADO em
-- "Quitado". Os 118 registros de produção já foram migrados por SQL no mesmo dia
-- (status='Quitado', etapa='quitado', evento `mudanca_status`). "Quitado direto ao
-- credor" continua separado e não muda.
--
-- O QUE ESTA MIGRAÇÃO FAZ. Só `CREATE OR REPLACE` de public.cobrancas_etapa_de_status:
-- retira o ramo especial que mandava "Quitado ao cliente" para cobrar/em_acao. O texto,
-- se reaparecer, cai em 'quitado' pelo /quitad/ — igual ao que a tela (cobEtapa) já faz.
-- Trigger, constraint e dados ficam como estão. Sem backfill: nenhum caso tem mais
-- esse status em produção (conferir antes com a query abaixo).
--
--   SELECT count(*) FROM cobrancas WHERE btrim(status) ~* '^quitado ao cliente$';  -- esperado 0
--
-- Rollback: reaplicar a função de 20260924c_cobrancas_etapa_trigger.sql.

CREATE OR REPLACE FUNCTION public.cobrancas_etapa_de_status(p_status text, p_processo text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE s text := btrim(coalesce(p_status,'')); tem_proc boolean := btrim(coalesce(p_processo,'')) <> '';
BEGIN
  IF s = '' THEN RETURN 'cobrar'; END IF;
  -- QuitaFácil é EXCLUSIVO (não aparece também em Cobrar / Fazer ação / Em ação).
  IF s ~* '^quita\s*f[aá]cil' THEN RETURN 'quitafacil'; END IF;
  -- "Quitado ao cliente" foi unificado em "Quitado" em 24/09/2026: não tem mais ramo
  -- próprio e, se reaparecer (dado legado), cai em 'quitado' pelo teste abaixo.
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
