-- 20260826_etapa_analise_e_status_manual
--
-- Dois defeitos que aparecem juntos, achados ao triar as 23 cobranças em "A cobrar"
-- (carteira não-Odontomundi, 26/08/2026 — caso Salete Terezinha Barbosa, 60c1f561):
--
-- (1) NÃO EXISTE ETAPA "ANÁLISE". O status manual `Análise` já é usado no CRM (e está na
--     lista branca da view `casos`), mas `cobrancas_etapa_check` não aceita 'analise' e
--     `cobrancas_set_etapa()` não tem ramo para ele. Resultado: a cobrança posta em
--     análise continua na fila "Cobrar" e entra na régua de WhatsApp — cobrando um valor
--     que justamente está sob conferência. Na Salete o sistema traz R$ 5.325,00 e o
--     extrato da credora traz R$ 3.475,36 de saldo pendente.
--
-- (2) STATUS MANUAL É APAGADO POR QUALQUER EDIÇÃO DE FICHA. `fn_casos_update()` recalcula
--     `status` a cada UPDATE na view `casos`, com `ELSE 'Cobrar'`. Como a view é o caminho
--     da UI, trocar só o telefone do devedor zera o status. Reproduzido em produção em
--     26/08/2026: UPDATE casos SET telefone=... na Salete levou `Análise` -> `Cobrar`.
--     Atinge todo status que não é derivável de `passo_atual`/`encerramento`:
--     'Análise', '8. Devolvida', '7. Reajuizar', 'Orto suspensa', '1. Ação de Cobrança' etc.
--     Hoje são 206 cobranças em '8. Devolvida' e 16 em '7. Reajuizar' expostas ao clobber.
--
-- (3) "AGUARDANDO 1ª ABORDAGEM" ERA LIDO COMO "EM CONTATO". O ramo `passo_atual ILIKE
--     '%aguardando%'` de fn_casos_update() casa com 'Aguardando 1ª abordagem' — que quer
--     dizer o contrário: ninguém abordou o devedor ainda. Resultado: status 'Em contato'
--     e etapa 'negociando', tirando o caso da fila de cobrança. Reproduzido em 26/08/2026
--     ao gravar o telefone de Gelcenoir Ferreira da Silva (4ed2dde3, R$ 24.613,03), que
--     nunca foi abordado. Há 57 casos com esse passo_atual — 56 ainda corretos só porque
--     não passaram pelo trigger desde então.
--
-- Idempotente. Não altera dado, só constraint e as duas funções.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. etapa 'analise' passa a ser valor aceito
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cobrancas DROP CONSTRAINT IF EXISTS cobrancas_etapa_check;
ALTER TABLE public.cobrancas ADD CONSTRAINT cobrancas_etapa_check
  CHECK (etapa IS NULL OR etapa = ANY (ARRAY[
    'cobrar','analise','negociando','acordo','fazer_acao','em_acao','execucao','travado','encerrado'
  ]));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. status 'Análise' passa a derivar etapa 'analise'
--    Ordem: depois de encerrado/execucao/fazer_acao (que são terminais ou já têm
--    processo) e ANTES de 'acordo'/'em_acao', para que a análise prevaleça sobre a
--    mera existência de numero_processo — o ponto da análise é parar a régua.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cobrancas_set_etapa()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
begin
  new.etapa := case
    when coalesce(new.status,'') ~* 'quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebido'
      then 'encerrado'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
     and coalesce(new.status,'') ~* 'execu|cumprimento|penhora|hasta|expropria'
      then 'execucao'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is null
     and coalesce(new.status,'') ~* 'fazer a[çc][ãa]o|para protocolar|reajuizar|a[çc][ãa]o de|monit[óo]ria|locupletamento'
      then 'fazer_acao'
    when coalesce(new.status,'') ~* 'an[áa]lise'
      then 'analise'
    when coalesce(new.status,'') ~* 'acordo'
      then 'acordo'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
      then 'em_acao'
    when coalesce(new.status,'') ~* 'negocia|proposta|em contato|contatad'
      then 'negociando'
    when coalesce(
           (select max(e.criado_em)
              from public.cobranca_partes cp
              join public.devedor_eventos e on e.devedor_id = cp.devedor_id
             where cp.cobranca_id = new.id),
           new.etapa_atualizada_em, new.updated_at, new.created_at
         ) < now() - interval '90 days'
      then 'travado'
    else 'cobrar'
  end;

  if tg_op = 'UPDATE' and new.etapa is distinct from old.etapa then
    new.etapa_atualizada_em := now();
  elsif tg_op = 'INSERT' then
    new.etapa_atualizada_em := coalesce(new.etapa_atualizada_em, now());
  end if;

  return new;
end;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. fn_casos_update() para de apagar status manual
--    A derivação continua valendo para os status que ELA mesma produz. Quando o CASE
--    cai no fallback 'Cobrar' e o status atual é um status manual, preserva o que está lá.
--    Única alteração em relação à versão anterior: a atribuição de `status`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_casos_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_status TEXT;
  v_cliente_id UUID;
  v_devedor_id UUID;
  evt JSONB;
BEGIN
  IF NEW.credor IS DISTINCT FROM OLD.credor AND NEW.credor IS NOT NULL AND NEW.credor <> '' THEN
    SELECT id INTO v_cliente_id FROM public.clientes
    WHERE LOWER(TRIM(nome)) = LOWER(TRIM(NEW.credor))
       OR LOWER(TRIM(COALESCE(nome_fantasia, ''))) = LOWER(TRIM(NEW.credor))
    LIMIT 1;
    IF v_cliente_id IS NULL THEN
      INSERT INTO public.clientes (nome, metadata)
      VALUES (NEW.credor, jsonb_build_object('origem','crm_auto_create','criado_em',NOW()))
      RETURNING id INTO v_cliente_id;
    END IF;
  END IF;

  v_status := CASE
    WHEN NEW.encerramento IS NOT NULL AND NEW.encerramento->>'tipo' = 'acordo'    THEN 'Acordo'
    WHEN NEW.encerramento IS NOT NULL AND NEW.encerramento->>'tipo' = 'judicial'  THEN 'Ação judicial'
    WHEN NEW.encerramento IS NOT NULL AND NEW.encerramento->>'tipo' = 'sem_exito' THEN 'Sem êxito'
    WHEN NEW.passo_atual = 'Encaminhado ao judicial' THEN 'Ação judicial'
    WHEN NEW.passo_atual ILIKE '%acordo aceito%'     THEN 'Acordo'
    WHEN NEW.passo_atual ILIKE '%negociação%'        THEN 'Em negociação'
    WHEN NEW.passo_atual ILIKE '%sem contato%'       THEN 'Em contato'
    -- "Aguardando 1ª abordagem" significa que NINGUEM falou com o devedor ainda:
    -- tem que sair antes do ramo generico '%aguardando%', que o classificava como
    -- 'Em contato' -> etapa 'negociando' e o tirava da fila de cobranca.
    WHEN NEW.passo_atual ILIKE '%1ª abordagem%'
      OR NEW.passo_atual ILIKE '%1a abordagem%'
      OR NEW.passo_atual ILIKE '%primeira abordagem%'                THEN 'Cobrar'
    WHEN NEW.passo_atual ILIKE '%aguardando%'        THEN 'Em contato'
    WHEN NEW.passo_atual ILIKE '%mensagem enviada%'  THEN 'Em contato'
    ELSE 'Cobrar'
  END;

  UPDATE public.cobrancas SET
    cliente_id          = COALESCE(v_cliente_id, cliente_id),
    passo_atual         = NEW.passo_atual,
    aguardando_resposta = COALESCE(NEW.aguardando_resposta, false),
    encerramento        = NEW.encerramento,
    acordo_final        = NEW.acordo_final,
    assigned_to         = NEW.assigned_to,
    divida              = COALESCE(NEW.divida, divida),
    -- ANTES: status = v_status  (zerava status manual em toda edição de ficha)
    status              = CASE
                            WHEN v_status <> 'Cobrar' THEN v_status
                            WHEN status IS NULL THEN v_status
                            -- só sobrescreve com o fallback os status que a própria
                            -- derivação produz; qualquer outro é escolha humana e fica
                            WHEN status IN ('Cobrar','Em contato','Em negociação',
                                            'Acordo','Ação judicial','Sem êxito') THEN v_status
                            ELSE status
                          END,
    fase                = CASE WHEN NEW.passo_atual = 'Encaminhado ao judicial' THEN 'judicial' ELSE fase END,
    metadata            = CASE
                            WHEN NEW.credor IS NOT NULL AND NEW.credor IS DISTINCT FROM OLD.credor
                            THEN COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('credorOriginal', NEW.credor)
                            ELSE metadata
                          END,
    updated_at          = NOW(),
    etapa_atualizada_em = COALESCE(NEW.etapa_atualizada_em, etapa_atualizada_em),
    objecao_adicionais  = NEW.objecao_adicionais,
    mesa_gestor         = NEW.mesa_gestor,
    checklist_judicial  = NEW.checklist_judicial
  WHERE id = NEW.id;

  SELECT devedor_id INTO v_devedor_id
  FROM public.cobranca_partes WHERE cobranca_id = NEW.id AND principal LIMIT 1;

  IF v_devedor_id IS NOT NULL THEN
    UPDATE public.devedores SET
      nome         = COALESCE(NEW.devedor, nome),
      telefone     = NEW.telefone,
      doc          = COALESCE(NEW.documento, doc),
      cliente_id   = COALESCE(v_cliente_id, cliente_id),
      endereco_crm = NEW.endereco_crm,
      updated_at   = NOW()
    WHERE id = v_devedor_id;
  END IF;

  IF NEW.historico IS NOT NULL
     AND jsonb_typeof(NEW.historico) = 'array'
     AND NEW.historico IS DISTINCT FROM OLD.historico THEN
    FOR evt IN SELECT * FROM jsonb_array_elements(NEW.historico)
    LOOP
      IF OLD.historico IS NULL OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(OLD.historico) AS old_evt WHERE old_evt = evt
      ) THEN
        INSERT INTO public.devedor_eventos (devedor_id, cobranca_id, tipo, payload, criado_em, autor_id)
        VALUES (v_devedor_id, NEW.id, 'historico_legacy', evt,
          COALESCE(NULLIF(evt->>'quando','')::TIMESTAMPTZ, NOW()), auth.uid());
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMIT;
