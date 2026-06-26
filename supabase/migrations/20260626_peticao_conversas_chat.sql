-- Estende public.peticao_conversas para o chat "Bia" (gerador unificado de peças no index.html).
-- A tabela base veio de 2026-05-11j_peticao_conversas.sql (JÁ em prod):
--   id, devedor_id, template_id, owner_id, mensagens jsonb, created_at, updated_at
--   + RLS conv_staff_all (proprietario/colaborador) e conv_owner (owner_id = auth.uid())
--   + trigger conversas_updated_at.
-- Esta migração só ACRESCENTA colunas usadas pelo chat. RLS e trigger já existem — não mexer.
-- Aplicar em prod: Supabase dashboard -> SQL Editor (NÃO `supabase db push`).

ALTER TABLE public.peticao_conversas
  ADD COLUMN IF NOT EXISTS caso_id   uuid,
  ADD COLUMN IF NOT EXISTS credor_id uuid REFERENCES public.clientes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tipo      text,
  ADD COLUMN IF NOT EXISTS titulo    text,
  ADD COLUMN IF NOT EXISTS peca_html text,
  ADD COLUMN IF NOT EXISTS calc      jsonb,
  ADD COLUMN IF NOT EXISTS status    text NOT NULL DEFAULT 'rascunho';

-- CHECK nomeado do status (idempotente — facilita o rollback).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peticao_conversas_status_chk') THEN
    ALTER TABLE public.peticao_conversas
      ADD CONSTRAINT peticao_conversas_status_chk
      CHECK (status IN ('rascunho','pronta','arquivada'));
  END IF;
END $$;

-- O front insere sem owner_id; a policy conv_owner exige owner_id = auth.uid().
ALTER TABLE public.peticao_conversas ALTER COLUMN owner_id SET DEFAULT auth.uid();

CREATE INDEX IF NOT EXISTS idx_peticao_conversas_status ON public.peticao_conversas(status);

COMMENT ON COLUMN public.peticao_conversas.caso_id   IS 'id do caso/devedor usado p/ montar o contexto da IA.';
COMMENT ON COLUMN public.peticao_conversas.credor_id IS 'cliente cedente (exequente), quando aplicável.';
COMMENT ON COLUMN public.peticao_conversas.tipo      IS 'Tipo de peça (CHAT_TIPOS): execucao, peticao-cobranca, cumprimento, etc.';
COMMENT ON COLUMN public.peticao_conversas.titulo    IS 'Rótulo legível da conversa (ex.: "Execução — Fulano").';
COMMENT ON COLUMN public.peticao_conversas.peca_html IS 'Corpo HTML atual da peça (sem masthead/CSS) — fonte para reabrir/editar.';
COMMENT ON COLUMN public.peticao_conversas.calc      IS 'Resultado determinístico do cálculo (_pet.calc), p/ remontar o memorial.';
COMMENT ON COLUMN public.peticao_conversas.status    IS 'rascunho | pronta | arquivada.';
