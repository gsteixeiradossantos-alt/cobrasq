-- 20260924c_cobrancas_etapa_trigger
-- PASSO 3 de 3 (pedido do Gustavo, 24/09/2026): fazer cada status ter a sua etapa.
--
-- O PROBLEMA. A coluna `cobrancas.etapa` foi criada em 29/07 e nunca mais foi mantida:
-- os 5+ lugares que gravam `status` (barra de lote, popover, Bia, importação, repasses)
-- não escrevem `etapa` junto. Por isso index.html deixou de ler a coluna e passou a
-- derivar a etapa do status em runtime (cobEtapa). Resultado: a TELA está certa e o
-- BANCO está velho — ex.: 1 caso "Análise" gravado como etapa `em_acao` (na tela ele
-- sempre apareceu em Análise), e 118 "Quitado ao cliente" gravados como `encerrado`
-- quando a regra é continuarem na fila enquanto o saldo não for decidido.
--
-- Achado de quebra: a constraint `cobrancas_etapa_check` nunca recebeu as 4 etapas
-- criadas em setembro — monitoria, locupletamento, cumprimento_sentenca e devolvida.
-- Gravar qualquer uma delas hoje estoura a constraint. É consertado aqui.
--
-- O QUE ESTA MIGRAÇÃO FAZ. Cria a função de-para status → etapa (espelho fiel da
-- cobEtapa do index.html) e um trigger BEFORE INSERT/UPDATE que a aplica a cada
-- gravação. A partir daqui a coluna se mantém sozinha, para relatório e ordenação.
--
-- O QUE ELA NÃO FAZ. Não muda a tela: cobEtapa continua sendo quem manda no chip do
-- pipeline. Isso é de propósito — a derivação em runtime usa sinais que o banco não
-- tem (cobAlertaAcao lê pendências calculadas no cliente), então flipar a precedência
-- agora trocaria um desencontro por outro. Um status literal "Fazer ação" cai em
-- fazer_acao aqui também; o que o SQL não reproduz é o caso que a TELA promove a
-- "Fazer ação" por falta de ajuizamento sem o status dizer isso.

ALTER TABLE cobrancas DROP CONSTRAINT IF EXISTS cobrancas_etapa_check;
ALTER TABLE cobrancas ADD CONSTRAINT cobrancas_etapa_check CHECK (
  etapa IS NULL OR etapa = ANY (ARRAY[
    'cobrar','telefone_invalido','analise','negociando','acordo','fazer_acao',
    'corrigir_acao','reajuizar','em_acao','monitoria','locupletamento',
    'cumprimento_sentenca','execucao','executar_acordo','travado','quitado',
    'devolvida','encerrado','quitafacil'
  ])
);

CREATE OR REPLACE FUNCTION public.cobrancas_etapa_de_status(p_status text, p_processo text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE s text := btrim(coalesce(p_status,'')); tem_proc boolean := btrim(coalesce(p_processo,'')) <> '';
BEGIN
  IF s = '' THEN RETURN 'cobrar'; END IF;
  -- QuitaFácil é EXCLUSIVO (não aparece também em Cobrar / Fazer ação / Em ação).
  IF s ~* '^quita\s*f[aá]cil' THEN RETURN 'quitafacil'; END IF;
  -- "Quitado ao cliente" ≠ "Quitado": só o capital voltou ao credor; o saldo (juros,
  -- multa, honorários) pode seguir em aberto, então o caso NÃO encerra — fica na fila
  -- até alguém decidir caso a caso. Confirmado pelo Gustavo em 24/09/2026. Por isso
  -- vem ANTES do teste de quitado abaixo.
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

CREATE OR REPLACE FUNCTION public.cobrancas_sync_etapa() RETURNS trigger LANGUAGE plpgsql AS $tg$
BEGIN
  NEW.etapa := public.cobrancas_etapa_de_status(NEW.status, NEW.numero_processo);
  RETURN NEW;
END $tg$;

DROP TRIGGER IF EXISTS trg_cobrancas_sync_etapa ON cobrancas;
CREATE TRIGGER trg_cobrancas_sync_etapa
  BEFORE INSERT OR UPDATE OF status, numero_processo ON cobrancas
  FOR EACH ROW EXECUTE FUNCTION public.cobrancas_sync_etapa();

-- Backfill de tudo o que está velho.
UPDATE cobrancas
   SET etapa = public.cobrancas_etapa_de_status(status, numero_processo)
 WHERE etapa IS DISTINCT FROM public.cobrancas_etapa_de_status(status, numero_processo);
