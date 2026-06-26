-- Coluna `intake` do chat "Bia" (Fase 3): guarda os campos estruturados do painel
-- "Dados da peça" (tipo, comarca, vara, processo, título, credor, réu) para reabrir
-- e continuar a conversa já preenchida. Aditiva e idempotente.
-- Aplicar em prod: Supabase dashboard -> SQL Editor (NÃO `supabase db push`).
ALTER TABLE public.peticao_conversas ADD COLUMN IF NOT EXISTS intake jsonb;
COMMENT ON COLUMN public.peticao_conversas.intake IS 'Campos estruturados do painel "Dados da peça" (comarca, vara, processo, titulo, credor, reu).';
