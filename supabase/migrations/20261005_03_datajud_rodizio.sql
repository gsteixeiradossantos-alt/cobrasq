-- 20261005_03 — Religa a captura de andamentos do DataJud em RODÍZIO.
--
-- Contexto: api/cron-datajud.js (Vercel) foi desligado em 25/08/2026 porque o loop
-- sequencial (até 200 processos, 1 chamada de até 20s cada) estourava os 300s da
-- função. Além disso o select usava limit=200 sem order: mesmo ligado, nunca
-- alcançaria os ~428 processos monitorados. Última captura datajud: 22/08/2026.
--
-- Medido em 05/10/2026: o DataJud aceita consulta EM LOTE (query terms com vários
-- numeroProcesso) — 20 processos numa chamada = 34s, ~1.500 movimentos; uma 2ª
-- chamada logo em seguida devolveu 429. Por isso: UMA chamada por execução, com
-- poucos processos, a cada 10 minutos, sempre os consultados há mais tempo.
--
-- Esta migração cria:
--   1) public.datajud_controle — quando cada cobrança foi consultada pela última vez;
--   2) public.datajud_proximos(n) — os n processos da vez (nunca consultados primeiro);
--   3) public.datajud_registrar_eventos(jsonb) — insert idempotente na timeline
--      (devedor_eventos) usando o índice único parcial uq_dev_eventos_datajud_dedup,
--      que o PostgREST não consegue usar como on_conflict;
--   4) o pg_cron 'datajud-andamentos' (*/10) chamando a Edge Function de mesmo nome.
--
-- Rollback: 20261005_03_datajud_rodizio_rollback.sql

-- 1) Controle do rodízio ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.datajud_controle (
  cobranca_id     uuid PRIMARY KEY REFERENCES public.cobrancas(id) ON DELETE CASCADE,
  consultado_em   timestamptz,
  ultimo_resultado text,          -- 'ok' | 'sem_dados' | 'erro' | 'sem_devedor'
  ultimo_erro     text,
  movimentos      integer,        -- nº de movimentos devolvidos na última consulta
  atualizado_em   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.datajud_controle IS
  'Rodízio da captura DataJud (Edge Function datajud-andamentos): última consulta de cada cobrança monitorada. Escrita só pelo service_role.';

ALTER TABLE public.datajud_controle ENABLE ROW LEVEL SECURITY;
-- Sem policies: só o service_role (Edge Function) lê e escreve.

CREATE INDEX IF NOT EXISTS idx_datajud_controle_consultado
  ON public.datajud_controle (consultado_em NULLS FIRST);

-- 2) Próximos da vez -----------------------------------------------------------
-- Mesmo filtro do cron antigo: monitorar_datajud = true e CNJ de 20 dígitos do TJPR
-- (J=8, TR=16). devedor_id vem do devedor PRINCIPAL em cobranca_partes (caminho
-- correto, ver CLAUDE.md); cai para cobranca.id só se não houver parte principal e
-- existir devedor com esse id (legado 1:1). 30 cobranças monitoradas em 05/10/2026
-- tinham principal ≠ cobranca.id — no cron antigo viravam FK violation ou eram puladas.
CREATE OR REPLACE FUNCTION public.datajud_proximos(p_limite integer DEFAULT 20)
RETURNS TABLE (cobranca_id uuid, devedor_id uuid, digitos text, formatado text, ja_sincronizado boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH alvos AS (
    SELECT c.id,
           regexp_replace(c.numero_processo, '\D', '', 'g') AS d
      FROM public.cobrancas c
     WHERE c.monitorar_datajud IS TRUE
       AND c.numero_processo IS NOT NULL
  ), validos AS (
    SELECT a.id, a.d,
           substr(a.d,1,7)||'-'||substr(a.d,8,2)||'.'||substr(a.d,10,4)||'.'||substr(a.d,14,1)||'.'||substr(a.d,15,2)||'.'||substr(a.d,17,4) AS f
      FROM alvos a
     WHERE length(a.d) = 20 AND substr(a.d,14,1) = '8' AND substr(a.d,15,2) = '16'
  )
  SELECT v.id,
         COALESCE(cp.devedor_id, dv.id) AS devedor_id,
         v.d,
         v.f,
         EXISTS (SELECT 1 FROM public.proc_intimacoes pi
                  WHERE pi.fonte = 'datajud' AND pi.processo_num = v.f) AS ja_sincronizado
    FROM validos v
    LEFT JOIN public.datajud_controle dc ON dc.cobranca_id = v.id
    LEFT JOIN public.cobranca_partes cp ON cp.cobranca_id = v.id AND cp.principal
    LEFT JOIN public.devedores dv ON dv.id = v.id
   ORDER BY dc.consultado_em NULLS FIRST, v.id
   LIMIT GREATEST(1, LEAST(p_limite, 50));
$$;

-- 3) Timeline idempotente ------------------------------------------------------
-- p_eventos: [{devedor_id, cobranca_id, payload:{acao_completa, fonte:'datajud', data, codigo, nome, dedup}}]
CREATE OR REPLACE FUNCTION public.datajud_registrar_eventos(p_eventos jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.devedor_eventos (devedor_id, cobranca_id, tipo, payload)
  SELECT (e->>'devedor_id')::uuid, (e->>'cobranca_id')::uuid, 'andamento_judicial', e->'payload'
    FROM jsonb_array_elements(COALESCE(p_eventos, '[]'::jsonb)) e
   WHERE e->'payload'->>'fonte' = 'datajud' AND e->'payload'->>'dedup' IS NOT NULL
  ON CONFLICT ((payload->>'dedup'))
     WHERE tipo = 'andamento_judicial' AND (payload->>'fonte') = 'datajud'
  DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.datajud_proximos(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.datajud_registrar_eventos(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.datajud_proximos(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.datajud_registrar_eventos(jsonb) TO service_role;

-- 4) Agendamento ----------------------------------------------------------------
-- 20 processos por execução × 1 execução a cada 10 min ≈ volta completa nos ~430
-- monitorados em menos de 4h. Mesmo padrão de segredo da djen-intimacoes (Vault).
DO $$
DECLARE
  v_url text := 'https://jokbxzhcctcwnbhkhgru.functions.supabase.co/datajud-andamentos';
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'CRON_INVOKE_SECRET' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_secret := NULL;
  END;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'CRON_INVOKE_SECRET não está no Vault; agendamento de datajud-andamentos NÃO criado.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('datajud-andamentos') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='datajud-andamentos');

  PERFORM cron.schedule(
    'datajud-andamentos',
    '*/10 * * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', 'Bearer ' || %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $cmd$, v_url, v_secret)
  );
END $$;
