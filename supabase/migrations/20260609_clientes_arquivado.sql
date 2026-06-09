-- D.3 (pente fino) — coluna `arquivado` em clientes pra preservar histórico
-- de cedentes que nunca tiveram devedor vinculado e foram cadastrados há muito
-- tempo. Não é hard delete: dá pra reverter qualquer hora.

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS arquivado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS arquivado_em timestamptz,
  ADD COLUMN IF NOT EXISTS arquivado_motivo text;

CREATE INDEX IF NOT EXISTS idx_clientes_arquivado
  ON public.clientes(arquivado) WHERE arquivado = false;

-- Limpeza inicial: arquiva órfãos criados há mais de 14 dias.
-- (Atualização aplicada manualmente em 2026-06-09 — 91 linhas afetadas.)
-- UPDATE public.clientes
-- SET arquivado = true,
--     arquivado_em = now(),
--     arquivado_motivo = 'pente-fino-2026-06-09: 0 devedores vinculados há >14d'
-- WHERE arquivado = false
--   AND created_at < (now() - interval '14 days')
--   AND NOT EXISTS (SELECT 1 FROM public.devedores d WHERE d.cliente_id = clientes.id);
