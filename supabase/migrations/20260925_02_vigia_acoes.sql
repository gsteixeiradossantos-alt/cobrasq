-- ============================================================================
-- 20260925_02 — Vigia de ações: devedor ativo que aparece em processo no DJEN
-- ============================================================================
-- Por quê: o devedor Wesley Cechin Gobatto (executado por nós no
-- 0005569-82.2025.8.16.0131) era AUTOR do 0002110-19.2025.8.16.0181 (JEC de
-- Marmeleiro) e levantou ~R$ 4.600 sem sabermos. A Edge Function `vigia-acoes`
-- procura cada devedor ativo no DJEN (comunicaapi.pje.jus.br, busca por nome) e
-- grava aqui o que achar em processo que NÃO é nosso.
--
-- Decisões do Gustavo (25/09/2026):
--   * universo = devedores de cobranças ativas + executados dos processos do
--     escritório (intimacoes_email.executado, processo sem cobrança vinculada);
--   * só vale achado nos tribunais da UF do NOSSO processo ("nosso processo for no
--     Paraná, corta por Paraná"): TJ, TRT e TRF daquela UF. UF = J.TR do CNJ; sem
--     CNJ, UF do devedor → do credor → PR. Regra em logica.mjs (ufReferencia).
--
--   vigia_acoes          achados, 1 linha por (alvo, processo); status da tela.
--                        alvo = 'dev:<devedor_id>' (COBRASQ) ou 'esc:<nome normalizado>'
--                        (executado do escritório, sem cadastro de devedor).
--   vigia_acoes_busca    quando cada alvo foi buscado pela última vez (fila diária)
--   vw_vigia_acoes_universo  (a) devedores de cobranças ATIVAS (mesmo critério do
--                        painel, `_pnlEncerrado`/`_STATUS_FORA_REGUA` no index.html):
--                        581 em 25/09/2026. fora_crm NÃO tira da vigia (acordo
--                        assinado continua sendo crédito a proteger);
--                        (b) executados dos processos do escritório sem cobrança
--                        (265 processos em 25/09/2026). A Edge Function separa os
--                        nomes ("A; B") e tira quem já está em (a).
--   cron `vigia-acoes`   a cada 3 min das 06:00 às 08:57 UTC (03:00–05:57 BRT),
--                        ~35 alvos por chamada → 60 chamadas/dia = 2.100 vagas para
--                        ~1.100 alvos (1 req/1,1 s; limite medido 20 req/~5 s).
--
-- Aditiva (2 tabelas, 1 view, 1 job). Rollback pareado. Nada sai para terceiros.
-- NÃO rodar `supabase db push` cego — aplicar via SQL Editor/MCP após review.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) Achados
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vigia_acoes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alvo             text NOT NULL,        -- 'dev:<uuid>' | 'esc:<nome normalizado>'
  origem           text NOT NULL DEFAULT 'cobrasq' CHECK (origem IN ('cobrasq','escritorio')),
  devedor_id       uuid REFERENCES public.devedores(id) ON DELETE CASCADE,  -- NULL = executado do escritório
  cobranca_id      uuid REFERENCES public.cobrancas(id) ON DELETE SET NULL,
  processo_ref     text,                 -- NOSSO processo contra ele (CNJ formatado), se houver
  uf_ref           text,                 -- UF que filtrou os tribunais
  nome_devedor     text,                 -- nome do cadastro na hora da busca
  nome_encontrado  text,                 -- como veio no diário (conferir homônimo)
  numero_processo  text NOT NULL,        -- CNJ formatado, sempre completo
  digitos          text NOT NULL CHECK (digitos ~ '^\d{20}$'),
  polo             text CHECK (polo IN ('A','P')),  -- A = devedor é AUTOR (penhorar crédito)
  tribunal         text,
  classe           text,
  orgao            text,
  link             text,
  primeira_data    date,
  ultima_data      date,
  qtd_comunicacoes integer NOT NULL DEFAULT 0,
  comunicacoes     text[] NOT NULL DEFAULT '{}',   -- ids das comunicações no DJEN
  partes           jsonb NOT NULL DEFAULT '[]',
  advogados        jsonb NOT NULL DEFAULT '[]',
  ultimo_texto     text,
  status           text NOT NULL DEFAULT 'novo' CHECK (status IN ('novo','visto','descartado')),
  nota             text,
  visto_por        text,
  visto_em         timestamptz,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_vigia_acoes_alvo_proc UNIQUE (alvo, digitos)
);
CREATE INDEX IF NOT EXISTS ix_vigia_acoes_status ON public.vigia_acoes (status, polo, ultima_data DESC);

COMMENT ON TABLE public.vigia_acoes IS
  'Vigia de ações (Edge Function vigia-acoes): devedor de cobrança ativa (origem cobrasq) ou executado de processo do escritório (origem escritorio) encontrado no DJEN, nos tribunais da UF do nosso processo, em processo que não é nosso. polo A = devedor autor (crédito a penhorar), P = réu de outro credor. A API não traz CPF: status descartado = homônimo/irrelevante, decidido na tela.';

ALTER TABLE public.vigia_acoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vigia_acoes_staff_select ON public.vigia_acoes;
CREATE POLICY vigia_acoes_staff_select ON public.vigia_acoes
  FOR SELECT USING (public.current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
-- Staff marca visto/descartado; inserir e apagar é do worker (service role) e do dono.
DROP POLICY IF EXISTS vigia_acoes_staff_update ON public.vigia_acoes;
CREATE POLICY vigia_acoes_staff_update ON public.vigia_acoes
  FOR UPDATE USING (public.current_user_papel() = ANY(ARRAY['proprietario','colaborador']))
             WITH CHECK (public.current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
DROP POLICY IF EXISTS vigia_acoes_owner_write ON public.vigia_acoes;
CREATE POLICY vigia_acoes_owner_write ON public.vigia_acoes
  FOR ALL USING (public.current_user_papel() = 'proprietario')
          WITH CHECK (public.current_user_papel() = 'proprietario');

-- ----------------------------------------------------------------------------
-- 2) Fila diária
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vigia_acoes_busca (
  alvo         text PRIMARY KEY,   -- mesma chave de vigia_acoes.alvo
  devedor_id   uuid REFERENCES public.devedores(id) ON DELETE CASCADE,
  nome_busca   text,          -- texto enviado à API (nome limpo); NULL = não buscável
  buscado_em   date,          -- dia (BRT) da última busca concluída; NULL após erro
  buscado_ts   timestamptz,
  comunicacoes integer,       -- total que a API devolveu (antes do filtro por nome exato)
  achados      integer,
  uf_ref       text,
  motivo       text,          -- nome_curto | truncado | NULL
  erro         text
);
ALTER TABLE public.vigia_acoes_busca ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vigia_busca_staff_select ON public.vigia_acoes_busca;
CREATE POLICY vigia_busca_staff_select ON public.vigia_acoes_busca
  FOR SELECT USING (public.current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
DROP POLICY IF EXISTS vigia_busca_owner_write ON public.vigia_acoes_busca;
CREATE POLICY vigia_busca_owner_write ON public.vigia_acoes_busca
  FOR ALL USING (public.current_user_papel() = 'proprietario')
          WITH CHECK (public.current_user_papel() = 'proprietario');

-- ----------------------------------------------------------------------------
-- 3) Universo — (a) devedores de cobranças ativas; (b) executados do escritório
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_vigia_acoes_universo
WITH (security_invoker = true) AS
SELECT * FROM (
  SELECT DISTINCT ON (d.id)
    'cobrasq'::text AS origem,
    d.id            AS devedor_id,
    c.id            AS cobranca_id,
    d.nome,
    nullif(regexp_replace(coalesce(c.numero_processo, ''), '\D', '', 'g'), '') AS processo_ref,
    d.uf            AS uf_devedor,
    cl.uf           AS uf_credor
  FROM public.cobrancas c
  JOIN public.cobranca_partes cp ON cp.cobranca_id = c.id
  JOIN public.devedores d        ON d.id = cp.devedor_id
  LEFT JOIN public.clientes cl   ON cl.id = c.cliente_id
  WHERE coalesce(c.is_draft, false) = false
    AND coalesce(c.arquivado, false) = false
    AND coalesce(d.is_draft, false) = false
    AND coalesce(c.status, '') NOT IN ('Quitado','Devolvida','Sem êxito','Recebido','Baixados','Encerrada',
                                       '5. Quitado','6. Baixados','8. Devolvida','9. Encerrada','Devolver')
    AND coalesce(c.status, '') !~* 'quitad'
    AND coalesce(c.status, '') !~* 'sem\s*[êe]xito'
    AND nullif(trim(d.nome), '') IS NOT NULL
  ORDER BY d.id, cp.principal DESC NULLS LAST, (c.numero_processo IS NOT NULL) DESC, c.created_at DESC
) a
UNION ALL
SELECT * FROM (
  -- Processo do escritório (intimação por e-mail nas nossas OABs) SEM cobrança
  -- vinculada: com cobrança, quem manda é a cobrança (quitada = fora da vigia).
  -- `nome` aqui é o campo executado inteiro ("A; B"): a função separa.
  SELECT DISTINCT ON (e.digitos)
    'escritorio'::text, NULL::uuid, NULL::uuid,
    e.executado, e.digitos, NULL::text, NULL::text
  FROM public.intimacoes_email e
  WHERE e.digitos ~ '^\d{20}$'
    AND nullif(trim(e.executado), '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.cobrancas c2
                    WHERE regexp_replace(coalesce(c2.numero_processo, ''), '\D', '', 'g') = e.digitos)
  ORDER BY e.digitos, e.recebido_em DESC NULLS LAST
) b;

-- ----------------------------------------------------------------------------
-- 4) Cron — a Edge Function anda a fila; quem já foi buscado hoje é pulado.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_url text := 'https://jokbxzhcctcwnbhkhgru.functions.supabase.co/vigia-acoes';
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'CRON_INVOKE_SECRET' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_secret := NULL;
  END;

  IF v_secret IS NULL THEN
    RAISE NOTICE 'CRON_INVOKE_SECRET não está no Vault; agendamento de vigia-acoes NÃO criado.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('vigia-acoes') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='vigia-acoes');

  PERFORM cron.schedule(
    'vigia-acoes',
    '*/3 6-8 * * *',
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
