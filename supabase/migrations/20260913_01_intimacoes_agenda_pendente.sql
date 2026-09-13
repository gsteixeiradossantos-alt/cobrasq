-- ============================================================================
-- 20260913_01 — fila "intimações pendentes de agenda" para as skills
-- ----------------------------------------------------------------------------
-- Decisão do gestor em 13/09/2026: prazos e audiências que chegam pelas
-- intimações (e-mail dos tribunais + DJEN) NÃO entram sozinhos no painel.
-- Quem grava em `audiencias`/`lembretes` é a skill (/audiencias-cobrasq,
-- /lembretes-cobrasq), porque só ela faz as três escritas juntas: tabela,
-- Google Agenda (espelho) e WhatsApp (trigger). Aqui só se prepara a FILA
-- que a skill consome — leitura, sem trigger, sem retroativo.
--
-- A view `vw_intimacoes_agenda_pendente` lista, por processo:
--   'audiencia'         — PROJUDI com data+hora lidas do ato ("Agendada para:
--                         26 de outubro de 2026 às 14:00, em <órgão>, Modalidade:
--                         <x>"), futura, sem linha igual em `audiencias`;
--   'audiencia_sem_data'— intimação de audiência sem data no texto (eproc TJRS/
--                         TJSC: "intimação eletrônica - Audiência"), últimos 20 dias,
--                         sem audiência futura nem lembrete do processo;
--   'prazo'             — intimação de tribunal ≠ TJPR (e-mail tipo 'intimacao' ou
--                         DJEN "Intimação"), últimos 20 dias, sem lembrete do
--                         processo nos últimos 20 dias. Traz o fatal ESTIMADO
--                         (15 dias úteis, art. 224 CPC) — a skill confirma no sistema.
-- Ajudantes: dia_util_forense(), somar_dias_uteis(), intimacao_parse_audiencia().
-- Aditiva; rollback pareado. NÃO rodar `supabase db push` cego.
-- ============================================================================

begin;

-- Seg–sex fora dos feriados nacionais (lista = feriadosBR() do painel).
CREATE OR REPLACE FUNCTION public.dia_util_forense(p_dia date)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
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

-- N-ésimo dia útil DEPOIS de p_base (n=1 → próximo dia útil).
CREATE OR REPLACE FUNCTION public.somar_dias_uteis(p_base date, p_n int)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d date := p_base; n int := 0;
BEGIN
  WHILE n < p_n LOOP
    d := d + 1;
    IF public.dia_util_forense(d) THEN n := n + 1; END IF;
  END LOOP;
  RETURN d;
END $$;

-- (data_hora BRT, tipo, órgão, modalidade) do ato de designação de audiência.
-- NULL em tudo se não for designação/redesignação ou não tiver data+hora.
CREATE OR REPLACE FUNCTION public.intimacao_parse_audiencia(p_ato text, p_ato_curado text,
  OUT data_hora timestamptz, OUT tipo text, OUT orgao text, OUT modalidade text)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m text[];
  meses text[] := array['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  mes int;
  txt text := coalesce(p_ato, '') || ' ' || coalesce(p_ato_curado, '');
BEGIN
  IF txt !~* 'audi[êe]ncia' OR txt !~* 'designad' OR txt ~* 'realizad|cancelad' THEN RETURN; END IF;
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
  tipo := regexp_replace(coalesce(initcap(m[1]), 'Audiência'), '^Audiência De ', 'Audiência de ');
END $$;

-- ----------------------------------------------------------------------------
-- A fila. security_invoker: staff lê (RLS de intimacoes_email/djen).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_intimacoes_agenda_pendente
  WITH (security_invoker = true) AS
WITH atos AS (
  SELECT 'e-mail'::text AS fonte, e.id, e.tribunal, e.numero_processo, e.cobranca_id, e.data_ato AS data_intimacao,
         e.ato, e.ato_curado, NULL::text AS link,
         (e.tipo = 'intimacao' OR coalesce(e.ato_curado, e.ato, '') ~* 'intima[çc][aã]o') AND coalesce(e.tipo,'') <> 'peticionamento' AS eh_intimacao
    FROM public.intimacoes_email e
   WHERE e.status <> 'ignorada'
  UNION ALL
  SELECT 'diário', d.id, d.tribunal, d.numero_processo, d.cobranca_id, d.data_disponibilizacao,
         d.texto_limpo, d.tipo_documento, d.link,
         coalesce(d.tipo_comunicacao, '') ~* '^intima'
    FROM public.intimacoes_djen d
   WHERE d.status <> 'ignorada' AND d.intimacao_email_id IS NULL
),
parsed AS (
  SELECT a.*, (public.intimacao_parse_audiencia(a.ato, a.ato_curado)).*,
         -- só o rótulo curto (ato_curado / tipo_documento): o texto longo do PROJUDI cita "audiência" à toa
         coalesce(a.ato_curado, '') ~* 'audi[êe]ncia' AS fala_audiencia
    FROM atos a
),
lembrete_recente AS (
  SELECT numero_processo, max(created_at) AS em FROM public.lembretes
   WHERE created_at > now() - interval '20 days' GROUP BY 1
),
audiencia_futura AS (
  SELECT numero_processo, data_hora FROM public.audiencias WHERE data_hora >= now() AND status = 'agendada'
)
SELECT 'audiencia'::text AS tipo_pendencia, p.fonte, p.id AS intimacao_id, p.tribunal, p.numero_processo, p.cobranca_id,
       p.data_intimacao, p.data_hora AS audiencia_em, p.tipo AS audiencia_tipo, p.orgao, p.modalidade,
       NULL::date AS fatal_estimado, coalesce(p.ato_curado, left(p.ato, 200)) AS ato, p.link
  FROM parsed p
 WHERE p.data_hora IS NOT NULL AND p.data_hora > now()
   AND NOT EXISTS (SELECT 1 FROM public.audiencias a WHERE a.numero_processo = p.numero_processo AND a.data_hora = p.data_hora)
UNION ALL
SELECT DISTINCT ON (p.numero_processo, p.data_intimacao)
       'audiencia_sem_data', p.fonte, p.id, p.tribunal, p.numero_processo, p.cobranca_id,
       p.data_intimacao, NULL, NULL, NULL, NULL, NULL, coalesce(p.ato_curado, left(p.ato, 200)), p.link
  FROM parsed p
 WHERE p.fala_audiencia AND p.data_hora IS NULL
   AND p.tribunal IS NOT NULL AND p.tribunal <> 'TJPR'
   AND coalesce(p.ato_curado, '') !~* 'realizad|cancelad'
   AND p.data_intimacao > current_date - 20
   AND NOT EXISTS (SELECT 1 FROM audiencia_futura f WHERE f.numero_processo = p.numero_processo)
   AND NOT EXISTS (SELECT 1 FROM lembrete_recente l WHERE l.numero_processo = p.numero_processo AND l.em > p.data_intimacao - 1)
UNION ALL
SELECT DISTINCT ON (p.numero_processo, p.data_intimacao)
       'prazo', p.fonte, p.id, p.tribunal, p.numero_processo, p.cobranca_id,
       p.data_intimacao, NULL, NULL, NULL, NULL,
       public.somar_dias_uteis(public.somar_dias_uteis(p.data_intimacao, 1), 15),
       coalesce(p.ato_curado, left(p.ato, 200)), p.link
  FROM parsed p
 WHERE p.eh_intimacao AND NOT p.fala_audiencia
   AND p.tribunal IS NOT NULL AND p.tribunal <> 'TJPR'
   AND p.data_intimacao > current_date - 20
   AND NOT EXISTS (SELECT 1 FROM lembrete_recente l WHERE l.numero_processo = p.numero_processo AND l.em > p.data_intimacao - 1)
ORDER BY 1, 7 DESC;

COMMENT ON VIEW public.vw_intimacoes_agenda_pendente IS
  'Fila para as skills audiencias-cobrasq / lembretes-cobrasq: audiências com data lidas do PROJUDI, audiências do eproc sem data e intimações de fora do PR sem lembrete. Só leitura; nada entra no painel sozinho (decisão de 13/09/2026).';

commit;
