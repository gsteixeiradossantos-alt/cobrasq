-- JÁ APLICADO EM PROD (versão 20260717232140). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- Bia Cobrança · Fase 3: fila de aprovações humanas — quando o devedor pede
-- algo fora da alçada da Bia (ex.: prazo fora do mês), a Bia registra aqui e o
-- proprietário decide no painel.
--
-- Colunas motivo (20260717233839) e sem_acrescimo (20260720124818) NÃO entram
-- aqui — ver arquivos irmãos. Grants = defaults do schema; trava real é a RLS
-- owner-only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bia_aprovacoes (
  id               bigserial PRIMARY KEY,
  tipo             text NOT NULL DEFAULT 'prazo_fora_do_mes',
  asaas_payment_id text,
  telefone         text,
  nome             text,
  data_pedida      date,
  status           text NOT NULL DEFAULT 'pendente',
  criado_em        timestamptz NOT NULL DEFAULT now(),
  decidido_em      timestamptz,
  decidido_por     text,
  resultado        text
);

CREATE INDEX IF NOT EXISTS idx_bia_aprovacoes_status ON public.bia_aprovacoes USING btree (status);
CREATE INDEX IF NOT EXISTS idx_bia_aprovacoes_tel    ON public.bia_aprovacoes USING btree (telefone);

ALTER TABLE public.bia_aprovacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bia_aprovacoes_owner_all ON public.bia_aprovacoes;
CREATE POLICY bia_aprovacoes_owner_all ON public.bia_aprovacoes
  FOR ALL
  USING (current_user_papel() = 'proprietario')
  WITH CHECK (current_user_papel() = 'proprietario');
