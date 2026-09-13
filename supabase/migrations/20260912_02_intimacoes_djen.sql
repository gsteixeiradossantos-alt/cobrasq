-- ============================================================================
-- 20260912_02 — tribunal pelo segmento do CNJ + intimações do DJEN
-- ----------------------------------------------------------------------------
-- Diagnóstico de 12/09/2026 (tela Intimações):
--
--   1) `intimacoes_email.tribunal` ficava NULL para qualquer processo fora da
--      Justiça Estadual PR/SC/RS (TRF4 = 4.04, TRT9 = 5.09, TJMT = 8.11…): o
--      worker email-intimacoes só conhecia 8.16/8.24/8.21. Como a aba "Urgentes"
--      filtra `tribunal <> 'TJPR'` (NULL <> x é NULL), esses atos — os mais
--      urgentes de todos, de fora do PR — NÃO apareciam em lugar nenhum além da
--      fila "A vincular". 19 linhas em produção (18 a_vincular).
--      Aqui: função `cnj_tribunal(texto)` com a tabela completa J.TR da
--      Res. CNJ 65/2008 + backfill das linhas existentes. O worker ganha a mesma
--      tabela (supabase/functions/email-intimacoes/index.ts).
--
--   2) No TJRS (eproc), ato ordinatório publicado só no DJEN (meio "D") não gera
--      e-mail do sistema; o escritório só fica sabendo pelo "prazo decorrido"
--      dias depois (5001563-63.2026.8.21.0133 em 13/08/2026 — recolher condução
--      do oficial; 5016566-68.2025.8.21.0141 em 14/08/2026 — audiência
--      designada). A API pública do DJEN (comunicaapi.pje.jus.br) entrega tudo
--      o que sai no diário por OAB. Aqui: tabela `intimacoes_djen`, alimentada
--      pela Edge Function `djen-intimacoes` (pg_cron diário), cruzamento com
--      `intimacoes_email` pelo CNJ + data (ver §3), e view `vw_intimacoes_so_diario`
--      com o que SÓ existe no diário — aba "Só no diário" do painel.
--
-- Aditiva (função nova, tabela nova, view nova, 1 índice em devedor_eventos,
-- 1 UPDATE de backfill idempotente, 1 job de cron). Rollback pareado.
-- NÃO rodar `supabase db push` cego — aplicar via SQL Editor/MCP após review.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) Tribunal a partir do número CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO)
-- ----------------------------------------------------------------------------
-- Aceita o número formatado ou os 20 dígitos. Devolve a sigla (TJPR, TRF4,
-- TRT9, TRE-PR, TJMSP…) ou NULL se não reconhecer. IMMUTABLE: pode ir em índice.
CREATE OR REPLACE FUNCTION public.cnj_tribunal(p_numero text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  WITH d AS (SELECT regexp_replace(coalesce(p_numero, ''), '\D', '', 'g') AS dig),
  seg AS (
    SELECT substr(dig, 14, 1) AS j, substr(dig, 15, 2) AS tr
    FROM d WHERE length(dig) = 20
  ),
  -- UF por código TR (Justiça Estadual 8.xx e Eleitoral 6.xx usam a mesma tabela)
  uf AS (
    SELECT * FROM (VALUES
      ('01','AC'),('02','AL'),('03','AP'),('04','AM'),('05','BA'),('06','CE'),
      ('07','DF'),('08','ES'),('09','GO'),('10','MA'),('11','MT'),('12','MS'),
      ('13','MG'),('14','PA'),('15','PB'),('16','PR'),('17','PE'),('18','PI'),
      ('19','RJ'),('20','RN'),('21','RS'),('22','RO'),('23','RR'),('24','SC'),
      ('25','SE'),('26','SP'),('27','TO')
    ) AS t(tr, uf)
  )
  SELECT CASE seg.j
    WHEN '1' THEN 'STF'
    WHEN '2' THEN 'CNJ'
    WHEN '3' THEN 'STJ'
    WHEN '4' THEN CASE WHEN seg.tr ~ '^0[1-6]$' THEN 'TRF' || substr(seg.tr, 2, 1) END
    WHEN '5' THEN CASE WHEN seg.tr = '90' THEN 'TST'
                       WHEN seg.tr::int BETWEEN 1 AND 24 THEN 'TRT' || seg.tr::int END
    WHEN '6' THEN CASE WHEN seg.tr = '00' THEN 'TSE'
                       ELSE (SELECT 'TRE-' || uf.uf FROM uf WHERE uf.tr = seg.tr) END
    WHEN '7' THEN 'STM'
    WHEN '8' THEN (SELECT 'TJ' || uf.uf FROM uf WHERE uf.tr = seg.tr)
    WHEN '9' THEN CASE seg.tr WHEN '13' THEN 'TJMMG' WHEN '21' THEN 'TJMRS' WHEN '26' THEN 'TJMSP' END
  END
  FROM seg;
$$;
COMMENT ON FUNCTION public.cnj_tribunal(text) IS
  'Sigla do tribunal pelo segmento J.TR do número CNJ (Res. CNJ 65/2008). NULL se não reconhecer.';

-- Backfill: só as linhas que o worker deixou sem tribunal e que têm CNJ válido.
UPDATE public.intimacoes_email
   SET tribunal = public.cnj_tribunal(coalesce(digitos, numero_processo))
 WHERE tribunal IS NULL
   AND public.cnj_tribunal(coalesce(digitos, numero_processo)) IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) Intimações do Diário de Justiça Eletrônico Nacional (DJEN), por OAB
-- ----------------------------------------------------------------------------
-- 1 linha = 1 comunicação do DJEN. `dedup` = sha1(cnj:data:texto) — a mesma
-- comunicação aparece na consulta das duas OABs do escritório e não pode
-- duplicar. Escrita pelo worker djen-intimacoes (service role, bypassa RLS).
CREATE TABLE IF NOT EXISTS public.intimacoes_djen (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  djen_id               text,                       -- id da comunicação na API
  hash_djen             text,                       -- hash informado pela API
  oab                   text,                       -- OAB consultada que trouxe a linha (ex.: 112743/PR)
  data_disponibilizacao date NOT NULL,              -- data de publicação no diário
  data_ato              date NOT NULL,              -- data do ato citada no texto ("(11/08/2026)"), senão = disponibilização
  tribunal              text,                       -- siglaTribunal (TJRS, TJPR…)
  orgao                 text,                       -- nomeOrgao
  tipo_comunicacao      text,                       -- Intimação, Citação…
  tipo_documento        text,                       -- Ato ordinatório, Despacho/Decisão…
  classe                text,                       -- nomeClasse
  meio                  text,                       -- D = diário, E = edital…
  numero_processo       text,                       -- CNJ formatado
  digitos               text,                       -- 20 dígitos (p/ casar)
  texto                 text,                       -- HTML como veio
  texto_limpo           text,                       -- texto sem tags (p/ tela e busca)
  link                  text,                       -- link do documento no tribunal
  destinatarios         jsonb,
  advogados             jsonb,
  status                text NOT NULL DEFAULT 'a_vincular'
                          CHECK (status IN ('a_vincular','vinculada','ignorada')),
  cobranca_id           uuid REFERENCES public.cobrancas(id) ON DELETE SET NULL,
  devedor_id            uuid,
  intimacao_email_id    uuid REFERENCES public.intimacoes_email(id) ON DELETE SET NULL,
  cruzado_em            timestamptz,                -- quando casou com um ato de e-mail
  evento_gravado        boolean NOT NULL DEFAULT false, -- já foi p/ devedor_eventos
  dedup                 text NOT NULL UNIQUE,
  raw                   jsonb,
  criado_em             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intim_djen_status ON public.intimacoes_djen(status, data_disponibilizacao DESC);
CREATE INDEX IF NOT EXISTS idx_intim_djen_proc   ON public.intimacoes_djen(digitos);
CREATE INDEX IF NOT EXISTS idx_intim_djen_cobr   ON public.intimacoes_djen(cobranca_id);
CREATE INDEX IF NOT EXISTS idx_intim_djen_email  ON public.intimacoes_djen(intimacao_email_id);

ALTER TABLE public.intimacoes_djen ENABLE ROW LEVEL SECURITY;
-- Mesmo modelo de intimacoes_email: staff lê; proprietário escreve (vincular/
-- arquivar pela tela); inserts em massa vêm do worker (service role).
DROP POLICY IF EXISTS intim_djen_staff_select ON public.intimacoes_djen;
CREATE POLICY intim_djen_staff_select ON public.intimacoes_djen
  FOR SELECT USING (public.current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
DROP POLICY IF EXISTS intim_djen_owner_write ON public.intimacoes_djen;
CREATE POLICY intim_djen_owner_write ON public.intimacoes_djen
  FOR ALL USING (public.current_user_papel() = 'proprietario')
          WITH CHECK (public.current_user_papel() = 'proprietario');

COMMENT ON TABLE public.intimacoes_djen IS
  'Comunicações do DJEN (comunicaapi.pje.jus.br) por OAB do escritório. intimacao_email_id NULL = só existe no diário (não chegou e-mail do tribunal). Escrita pelo worker djen-intimacoes.';

-- Idempotência dos andamentos vindos do diário em devedor_eventos (espelha
-- uq_dev_eventos_email_dedup da migração 2026-07-02).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dev_eventos_djen_dedup
  ON public.devedor_eventos ((payload->>'dedup'))
  WHERE tipo = 'andamento_judicial' AND payload->>'fonte' = 'djen';

-- ----------------------------------------------------------------------------
-- 3) Cruzamento DJEN × e-mail: mesmo CNJ e data do ato do e-mail dentro de
--    [data_ato − 3, data_disponibilizacao + 3]. No PROJUDI (TJPR) o diário sai
--    ~9 dias depois do movimento ("movimento (seq. 129) … (11/08/2026)"
--    publicado em 20/08) — por isso a janela começa na data do ato citada no
--    texto, não na publicação; no eproc (TJRS/TJSC) as duas coincidem.
--    Só olha os últimos p_dias de diário (o worker chama todo dia; o e-mail
--    pode chegar antes ou depois da publicação). Devolve quantas casaram.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.intimacoes_djen_cruzar(p_dias int DEFAULT 10)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n int;
BEGIN
  WITH cand AS (
    SELECT DISTINCT ON (d.id) d.id AS djen_id, e.id AS email_id
      FROM public.intimacoes_djen d
      JOIN public.intimacoes_email e
        ON e.digitos = d.digitos
       AND e.status <> 'ignorada'
       AND e.data_ato BETWEEN d.data_ato - 3 AND d.data_disponibilizacao + 3
     WHERE d.intimacao_email_id IS NULL
       AND d.digitos IS NOT NULL
       AND d.data_disponibilizacao >= current_date - p_dias
     ORDER BY d.id, abs(e.data_ato - d.data_ato), e.recebido_em DESC
  )
  UPDATE public.intimacoes_djen d
     SET intimacao_email_id = cand.email_id, cruzado_em = now()
    FROM cand
   WHERE d.id = cand.djen_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.intimacoes_djen_cruzar(int) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.intimacoes_djen_cruzar(int) IS
  'Casa intimacoes_djen com intimacoes_email pelo CNJ ± 3 dias. Chamada pelo worker djen-intimacoes (service role).';

-- ----------------------------------------------------------------------------
-- 4) View "Só no diário": o que o DJEN publicou e nenhum e-mail trouxe.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_intimacoes_so_diario
  WITH (security_invoker = true) AS
SELECT id, data_disponibilizacao, data_ato, tribunal, orgao, tipo_comunicacao, tipo_documento,
       classe, numero_processo, digitos, texto_limpo, link, status, cobranca_id, devedor_id, criado_em
  FROM public.intimacoes_djen
 WHERE intimacao_email_id IS NULL
   AND status <> 'ignorada'
 ORDER BY data_disponibilizacao DESC, criado_em DESC;

-- ----------------------------------------------------------------------------
-- 5) Cron diário do worker (mesmo padrão de email-intimacoes): 11:00 UTC =
--    08:00 BRT, depois que o diário do dia já está no ar. Só agenda se o
--    CRON_INVOKE_SECRET estiver no Vault. O worker olha os últimos 5 dias
--    (idempotente por dedup), então uma falha num dia não perde nada.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_url text := 'https://jokbxzhcctcwnbhkhgru.functions.supabase.co/djen-intimacoes';
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'CRON_INVOKE_SECRET' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_secret := NULL;
  END;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'CRON_INVOKE_SECRET não está no Vault; agendamento de djen-intimacoes NÃO criado.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('djen-intimacoes') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='djen-intimacoes');

  PERFORM cron.schedule(
    'djen-intimacoes',
    '0 11 * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', 'Bearer ' || %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000
      );
    $cmd$, v_url, v_secret)
  );
END $$;

commit;
