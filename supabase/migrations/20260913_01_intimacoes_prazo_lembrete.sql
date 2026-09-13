-- ============================================================================
-- 20260913_01 — intimação de fora do PR vira lembrete "Conferir intimação"
-- ----------------------------------------------------------------------------
-- Decisão do gestor em 13/09/2026: prazos de TJSC/TJRS/TRF4/TRT9/TJMT… não
-- apareciam em lugar nenhum para cumprir — só nas abas "Urgentes"/"Só no
-- diário". Agora toda INTIMAÇÃO nova de tribunal ≠ TJPR (chegue por e-mail ou
-- só pelo diário) cria UM lembrete em `lembretes` (tarefa, 08:00 do dia útil
-- seguinte, avisos no WhatsApp pela trigger que já existe) com o prazo fatal
-- ESTIMADO (15 dias úteis, art. 224 CPC) no texto. O fatal real o gestor fixa
-- pela skill lembretes-cobrasq depois de abrir o sistema — a rotina NÃO
-- inventa data fatal (prazo de 5/10 dias, contagem por outro marco etc.).
--
-- O que dispara: e-mail com tipo 'intimacao' ou ato "Intimação…" (nunca
-- peticionamento do escritório); DJEN com tipoComunicacao "Intimação".
-- Movimentação interna (juntada, conclusão) não gera. TJPR fica no fluxo
-- atual (analise-prazos-lote / skill). Dedup: 1 lembrete por processo a cada
-- 10 dias (a mesma intimação chega por e-mail E pelo diário; duas no mesmo
-- processo na mesma semana = uma conferência).
--
-- Aditiva: 3 funções + 2 triggers. Não cria lembrete retroativo. Rollback
-- pareado. NÃO rodar `supabase db push` cego.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) Dia útil forense: seg–sex, fora dos feriados nacionais (mesma lista de
--    feriadosBR() do painel; Páscoa por Meeus/Jones/Butcher).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dia_util_forense(p_dia date)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  y int := extract(year from p_dia);
  a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int;
  pascoa date;
BEGIN
  IF extract(isodow from p_dia) IN (6, 7) THEN RETURN false; END IF;
  a := y % 19; b := y / 100; c := y % 100; d := b / 4; e := b % 4;
  f := (b + 8) / 25; g := (b - f + 1) / 3; h := (19*a + b - d - g + 15) % 30;
  i := c / 4; k := c % 4; l := (32 + 2*e + 2*i - h - k) % 7; m := (a + 11*h + 22*l) / 451;
  pascoa := make_date(y, (h + l - 7*m + 114) / 31, ((h + l - 7*m + 114) % 31) + 1);
  RETURN p_dia NOT IN (
    make_date(y,1,1), make_date(y,4,21), make_date(y,5,1), make_date(y,9,7),
    make_date(y,10,12), make_date(y,11,2), make_date(y,11,15), make_date(y,11,20), make_date(y,12,25),
    pascoa - 47, pascoa - 46, pascoa - 2, pascoa + 60
  );
END $$;
COMMENT ON FUNCTION public.dia_util_forense(date) IS 'Seg–sex fora dos feriados nacionais (lista = feriadosBR() do painel). Não considera feriado local nem recesso.';

-- N-ésimo dia útil DEPOIS de p_base (n=1 → próximo dia útil).
CREATE OR REPLACE FUNCTION public.somar_dias_uteis(p_base date, p_n int)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE d date := p_base; n int := 0;
BEGIN
  WHILE n < p_n LOOP
    d := d + 1;
    IF public.dia_util_forense(d) THEN n := n + 1; END IF;
  END LOOP;
  RETURN d;
END $$;

-- ----------------------------------------------------------------------------
-- 2) Cria o lembrete (idempotente por processo/10 dias). Devolve o id criado
--    ou NULL quando não gera (TJPR, sem tribunal, já existe).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.intimacao_criar_lembrete(
  p_tribunal text, p_numero text, p_cobranca uuid, p_data date, p_ato text, p_fonte text, p_link text
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
  IF p_tribunal IS NULL OR p_tribunal = 'TJPR' OR p_data IS NULL THEN RETURN NULL; END IF;

  -- Já tem conferência agendada para este processo nos últimos 10 dias? Não repete.
  IF p_numero IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.lembretes l
        WHERE l.numero_processo = p_numero
          AND l.created_by LIKE 'auto: intimação%'
          AND l.created_at > now() - interval '10 days'
     ) THEN
    RETURN NULL;
  END IF;

  -- Conferir no próximo dia útil (se a intimação é de hoje ou do passado, amanhã útil).
  v_conferir := public.somar_dias_uteis(greatest(p_data, current_date), 1);
  -- Estimativa art. 224 CPC: publicação = 1º dia útil após a disponibilização;
  -- o prazo começa no dia útil seguinte e corre 15 dias úteis.
  v_fatal := public.somar_dias_uteis(public.somar_dias_uteis(p_data, 1), 15);

  -- FK: só grava cobranca_id se a cobrança existe.
  SELECT id INTO v_cobr FROM public.cobrancas WHERE id = p_cobranca;

  INSERT INTO public.lembretes
    (titulo, descricao, data_hora, numero_processo, cobranca_id, telefone_notificacao, status, origem, created_by)
  VALUES (
    left('Conferir intimação ' || coalesce(p_numero, '(sem número)') || ' — ' || coalesce(p_ato, 'intimação'), 180),
    p_tribunal || ' · intimação de ' || to_char(p_data, 'DD/MM/YYYY') || ' (' || p_fonte || ').'
      || E'\nPrazo ESTIMADO (15 dias úteis): ' || to_char(v_fatal, 'DD/MM/YYYY')
      || ' — abrir o sistema, confirmar o prazo real e fixar pela skill lembretes-cobrasq.'
      || CASE WHEN p_link IS NOT NULL THEN E'\n' || p_link ELSE '' END,
    ((v_conferir + time '08:00') AT TIME ZONE 'America/Sao_Paulo'),
    p_numero, v_cobr,
    '46999223332',                -- número do escritório (mesmo da skill lembretes-cobrasq)
    'agendado', 'manual',
    'auto: intimação ' || p_fonte
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.intimacao_criar_lembrete(text, text, uuid, date, text, text, text) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3) Triggers nas duas fontes.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_intim_email_lembrete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status <> 'ignorada'
     AND coalesce(NEW.tipo, '') <> 'peticionamento'
     AND (NEW.tipo = 'intimacao' OR coalesce(NEW.ato_curado, NEW.ato, '') ~* 'intima[çc][aã]o') THEN
    PERFORM public.intimacao_criar_lembrete(
      NEW.tribunal, NEW.numero_processo, NEW.cobranca_id, NEW.data_ato,
      coalesce(NEW.ato_curado, NEW.ato), 'e-mail', NULL);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_intim_email_lembrete ON public.intimacoes_email;
CREATE TRIGGER trg_intim_email_lembrete
  AFTER INSERT ON public.intimacoes_email
  FOR EACH ROW EXECUTE FUNCTION public.trg_intim_email_lembrete();

CREATE OR REPLACE FUNCTION public.trg_intim_djen_lembrete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status <> 'ignorada' AND coalesce(NEW.tipo_comunicacao, '') ~* '^intima' THEN
    PERFORM public.intimacao_criar_lembrete(
      NEW.tribunal, NEW.numero_processo, NEW.cobranca_id, NEW.data_disponibilizacao,
      coalesce(NEW.tipo_documento, 'intimação'), 'diário', NEW.link);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_intim_djen_lembrete ON public.intimacoes_djen;
CREATE TRIGGER trg_intim_djen_lembrete
  AFTER INSERT ON public.intimacoes_djen
  FOR EACH ROW EXECUTE FUNCTION public.trg_intim_djen_lembrete();

commit;
