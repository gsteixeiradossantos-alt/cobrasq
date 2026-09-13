-- ============================================================================
-- 20260913_02 — intimação de audiência agenda sozinha em `audiencias`
-- ----------------------------------------------------------------------------
-- Decisão do gestor em 13/09/2026: "TJPR automático + lembrete p/ eproc" e
-- "importar as futuras que faltam". Depende de 20260913_01 (usa
-- intimacao_criar_lembrete / somar_dias_uteis).
--
-- O PROJUDI (TJPR) manda no e-mail o ato completo:
--   "Audiência de Conciliação Designada (Agendada para: 26 de outubro de 2026
--    às 14:00, em Juizado Especial Cível de Francisco Beltrão, Modalidade:
--    Semipresencial)"
-- Quando o ato tem "audiência … designada/redesignada" COM data e hora, a
-- trigger grava em `audiencias` (origem 'projudi_import', tipo, órgão/comarca,
-- modalidade em `sala`, cobranca_id se vinculada) e a trigger de `audiencias`
-- cuida dos avisos. Redesignação atualiza a audiência futura do mesmo processo
-- (não duplica). Mesma data/hora já cadastrada à mão → não mexe.
-- O eproc (TJRS/TJSC) manda só "intimação eletrônica - Audiência", sem data:
-- vira lembrete "Conferir e agendar audiência" no dia útil seguinte (qualquer
-- tribunal, TJPR incluído, quando faltar data/hora).
--
-- Retroativo (uma vez, no fim): audiências FUTURAS do TJPR já intimadas que
-- ainda não estão em `audiencias` (por processo + data). Rollback pareado.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) intimacao_criar_lembrete ganha p_forcar (ignora o filtro "≠ TJPR").
--    A assinatura de 7 parâmetros continua existindo (chamada pelas triggers
--    da 20260913_01) e delega para a de 8.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.intimacao_criar_lembrete(
  p_tribunal text, p_numero text, p_cobranca uuid, p_data date, p_ato text, p_fonte text, p_link text,
  p_forcar boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conferir date;
  v_fatal    date;
  v_id       uuid;
  v_cobr     uuid;
BEGIN
  IF p_data IS NULL THEN RETURN NULL; END IF;
  IF NOT p_forcar AND (p_tribunal IS NULL OR p_tribunal = 'TJPR') THEN RETURN NULL; END IF;

  IF p_numero IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.lembretes l
        WHERE l.numero_processo = p_numero
          AND l.created_by LIKE 'auto: intimação%'
          AND l.created_at > now() - interval '10 days'
     ) THEN
    RETURN NULL;
  END IF;

  v_conferir := public.somar_dias_uteis(greatest(p_data, current_date), 1);
  v_fatal    := public.somar_dias_uteis(public.somar_dias_uteis(p_data, 1), 15);
  SELECT id INTO v_cobr FROM public.cobrancas WHERE id = p_cobranca;

  INSERT INTO public.lembretes
    (titulo, descricao, data_hora, numero_processo, cobranca_id, telefone_notificacao, status, origem, created_by)
  VALUES (
    left('Conferir intimação ' || coalesce(p_numero, '(sem número)') || ' — ' || coalesce(p_ato, 'intimação'), 180),
    coalesce(p_tribunal, '?') || ' · intimação de ' || to_char(p_data, 'DD/MM/YYYY') || ' (' || p_fonte || ').'
      || E'\nPrazo ESTIMADO (15 dias úteis): ' || to_char(v_fatal, 'DD/MM/YYYY')
      || ' — abrir o sistema, confirmar o prazo real e fixar pela skill lembretes-cobrasq.'
      || CASE WHEN p_link IS NOT NULL THEN E'\n' || p_link ELSE '' END,
    ((v_conferir + time '08:00') AT TIME ZONE 'America/Sao_Paulo'),
    p_numero, v_cobr, '46999223332', 'agendado', 'manual',
    'auto: intimação ' || p_fonte
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.intimacao_criar_lembrete(text, text, uuid, date, text, text, text, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.intimacao_criar_lembrete(
  p_tribunal text, p_numero text, p_cobranca uuid, p_data date, p_ato text, p_fonte text, p_link text
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.intimacao_criar_lembrete(p_tribunal, p_numero, p_cobranca, p_data, p_ato, p_fonte, p_link, false);
$$;
REVOKE ALL ON FUNCTION public.intimacao_criar_lembrete(text, text, uuid, date, text, text, text) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2) Extrai (data_hora BRT, tipo, órgão, modalidade) do texto do ato.
--    Formatos aceitos: "Agendada para: 26 de outubro de 2026 às 14:00, em <órgão>,
--    Modalidade: <x>" (ato cru do PROJUDI) e "… - 26/10/2026 14:00" (ato_curado).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.intimacao_parse_audiencia(p_ato text, p_ato_curado text,
  OUT data_hora timestamptz, OUT tipo text, OUT orgao text, OUT modalidade text)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m text[];
  meses text[] := array['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  mes int;
  txt text := coalesce(p_ato, '') || ' ' || coalesce(p_ato_curado, '');
BEGIN
  -- Só designação/redesignação; "realizada", "cancelada", "não realizada" não agendam.
  IF txt !~* 'audi[êe]ncia' OR txt !~* 'designad' OR txt ~* 'realizad|cancelad|n[ãa]o realizad' THEN RETURN; END IF;

  m := regexp_match(coalesce(p_ato, ''), 'Agendada para:\s*(\d{1,2}) de (\w+) de (\d{4})\s*[àa]s\s*(\d{1,2}):(\d{2})(?:,\s*em\s+([^,)]+))?(?:,\s*Modalidade:\s*([^)]+))?', 'i');
  IF m IS NOT NULL THEN
    mes := array_position(meses, lower(m[2]));
    IF mes IS NULL THEN RETURN; END IF;
    data_hora := (make_timestamp(m[3]::int, mes, m[1]::int, m[4]::int, m[5]::int, 0)) AT TIME ZONE 'America/Sao_Paulo';
    orgao := nullif(btrim(m[6]), '');
    modalidade := nullif(btrim(m[7]), '');
  ELSE
    m := regexp_match(txt, '(\d{2})/(\d{2})/(\d{4})\s+(\d{1,2}):(\d{2})');
    IF m IS NULL THEN RETURN; END IF;
    data_hora := (make_timestamp(m[3]::int, m[2]::int, m[1]::int, m[4]::int, m[5]::int, 0)) AT TIME ZONE 'America/Sao_Paulo';
  END IF;

  m := regexp_match(txt, '(Audi[êe]ncia (?:de |una )?[[:alpha:]çãõáéíóú]+(?: e [[:alpha:]çãõáéíóú]+)?)', 'i');
  tipo := coalesce(initcap(m[1]), 'Audiência');
  tipo := regexp_replace(tipo, '^Audiência De ', 'Audiência de ');
END $$;

-- ----------------------------------------------------------------------------
-- 3) Agenda (ou reagenda) a partir de um ato. Devolve 'inserida' | 'reagendada'
--    | 'ja_existia' | 'lembrete' | NULL (não é designação).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.intimacao_agendar_audiencia(
  p_tribunal text, p_numero text, p_cobranca uuid, p_data_ato date, p_ato text, p_ato_curado text, p_fonte text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p record;
  v_cobr uuid;
  v_comarca text;
  v_id uuid;
  v_redes boolean := coalesce(p_ato, '') || coalesce(p_ato_curado, '') ~* 'redesignad';
BEGIN
  IF coalesce(p_ato, '') || ' ' || coalesce(p_ato_curado, '') !~* 'audi[êe]ncia' THEN RETURN NULL; END IF;
  IF coalesce(p_ato, '') || ' ' || coalesce(p_ato_curado, '') ~* 'realizad|cancelad' THEN RETURN NULL; END IF;

  SELECT * INTO p FROM public.intimacao_parse_audiencia(p_ato, p_ato_curado);

  -- Sem data/hora (eproc TJRS/TJSC, ou PROJUDI fora do padrão): lembrete p/ conferir.
  IF p.data_hora IS NULL THEN
    PERFORM public.intimacao_criar_lembrete(p_tribunal, p_numero, p_cobranca, p_data_ato,
      'Agendar audiência (data e hora no sistema do tribunal)', p_fonte, NULL, true);
    RETURN 'lembrete';
  END IF;
  IF p.data_hora < now() THEN RETURN NULL; END IF;  -- audiência passada: histórico, não agenda.

  SELECT id INTO v_cobr FROM public.cobrancas WHERE id = p_cobranca;
  -- "Juizado Especial Cível de Francisco Beltrão" → comarca "Francisco Beltrão"
  v_comarca := nullif(btrim(regexp_replace(coalesce(p.orgao, ''), '^.*\sde\s', '')), '');

  -- Mesma data/hora já cadastrada (à mão ou por rodada anterior): nada a fazer.
  IF EXISTS (SELECT 1 FROM public.audiencias a WHERE a.numero_processo = p_numero AND a.data_hora = p.data_hora) THEN
    RETURN 'ja_existia';
  END IF;

  -- Redesignação: move a audiência futura ainda agendada deste processo.
  IF v_redes THEN
    SELECT id INTO v_id FROM public.audiencias a
     WHERE a.numero_processo = p_numero AND a.status = 'agendada' AND a.data_hora >= now()
     ORDER BY a.data_hora LIMIT 1;
    IF v_id IS NOT NULL THEN
      UPDATE public.audiencias
         SET data_hora = p.data_hora,
             tipo_audiencia = coalesce(p.tipo, tipo_audiencia),
             orgao_julgador = coalesce(p.orgao, orgao_julgador),
             comarca = coalesce(v_comarca, comarca),
             sala = coalesce(CASE WHEN p.modalidade IS NOT NULL THEN 'Modalidade: ' || p.modalidade END, sala),
             observacao = concat_ws(E'\n', observacao, 'Redesignada pela intimação de ' || to_char(p_data_ato, 'DD/MM/YYYY') || ' (' || p_fonte || ').'),
             updated_at = now()
       WHERE id = v_id;
      RETURN 'reagendada';
    END IF;
  END IF;

  INSERT INTO public.audiencias
    (numero_processo, comarca, orgao_julgador, tipo_audiencia, sala, data_hora, observacao,
     telefone_notificacao, cobranca_id, status, origem, created_by)
  VALUES (
    p_numero, v_comarca, p.orgao, p.tipo,
    CASE WHEN p.modalidade IS NOT NULL THEN 'Modalidade: ' || p.modalidade END,
    p.data_hora,
    'Agendada pela intimação de ' || to_char(p_data_ato, 'DD/MM/YYYY') || ' (' || p_fonte || '): ' || left(coalesce(p_ato, p_ato_curado), 300),
    '46999223332', v_cobr, 'agendada', 'projudi_import', 'auto: intimação ' || p_fonte
  );
  RETURN 'inserida';
END $$;
REVOKE ALL ON FUNCTION public.intimacao_agendar_audiencia(text, text, uuid, date, text, text, text) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Triggers. O nome "trg_intim_audiencia_*" vem antes de "trg_intim_email_*"
--    na ordem alfabética (ordem de disparo do Postgres): quando a audiência sem
--    data vira lembrete, o "Conferir intimação" genérico da 20260913_01 é
--    deduplicado pela regra processo/10 dias.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_intim_audiencia_email()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status <> 'ignorada' AND coalesce(NEW.tipo, '') <> 'peticionamento' THEN
    PERFORM public.intimacao_agendar_audiencia(NEW.tribunal, NEW.numero_processo, NEW.cobranca_id,
      NEW.data_ato, NEW.ato, NEW.ato_curado, 'e-mail');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_intim_audiencia_email ON public.intimacoes_email;
CREATE TRIGGER trg_intim_audiencia_email
  AFTER INSERT ON public.intimacoes_email
  FOR EACH ROW EXECUTE FUNCTION public.trg_intim_audiencia_email();

CREATE OR REPLACE FUNCTION public.trg_intim_audiencia_djen()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Só quando o diário é a única fonte (o e-mail do PROJUDI, quando vem, é mais rico).
  IF NEW.status <> 'ignorada' AND coalesce(NEW.texto_limpo, '') ~* 'audi[êe]ncia.{0,80}designad' THEN
    PERFORM public.intimacao_agendar_audiencia(NEW.tribunal, NEW.numero_processo, NEW.cobranca_id,
      NEW.data_disponibilizacao, NEW.texto_limpo, NEW.tipo_documento, 'diário');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_intim_audiencia_djen ON public.intimacoes_djen;
CREATE TRIGGER trg_intim_audiencia_djen
  AFTER INSERT ON public.intimacoes_djen
  FOR EACH ROW EXECUTE FUNCTION public.trg_intim_audiencia_djen();

-- ----------------------------------------------------------------------------
-- 5) Retroativo: audiências FUTURAS já intimadas (TJPR, com data+hora) que
--    faltam em `audiencias`. Uma vez só; não gera lembrete (só o INSERT).
-- ----------------------------------------------------------------------------
DO $$
DECLARE r record; v text; n_ins int := 0; n_ja int := 0;
BEGIN
  FOR r IN
    SELECT e.* FROM public.intimacoes_email e
     WHERE e.status <> 'ignorada' AND e.tribunal = 'TJPR'
       AND coalesce(e.ato, '') || ' ' || coalesce(e.ato_curado, '') ~* 'audi[êe]ncia'
       AND (public.intimacao_parse_audiencia(e.ato, e.ato_curado)).data_hora > now()
     ORDER BY e.data_ato, e.criado_em
  LOOP
    v := public.intimacao_agendar_audiencia(r.tribunal, r.numero_processo, r.cobranca_id, r.data_ato, r.ato, r.ato_curado, 'e-mail');
    IF v = 'inserida' OR v = 'reagendada' THEN n_ins := n_ins + 1; ELSIF v = 'ja_existia' THEN n_ja := n_ja + 1; END IF;
  END LOOP;
  RAISE NOTICE 'retroativo: % agendadas/reagendadas, % já existiam', n_ins, n_ja;
END $$;

commit;
