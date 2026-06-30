-- ============================================================
-- WhatsApp · aba Pendentes — registro do desfecho da triagem humana
-- ============================================================
-- O redesign da fila de Pendentes precisa PERSISTIR como cada conversa foi
-- resolvida (para a visão "Resolvidas", os insights e a taxa de resposta) e
-- marcar números como "régua bloqueada" (Spam / engano não recebe mais disparos
-- automáticos). Tudo isso mora no estado por telefone já existente
-- (whatsapp_atendimentos, ver 20260702_bia_atendimento.sql); aqui só
-- ACRESCENTAMOS colunas — nenhuma é obrigatória, então o front degrada bem
-- enquanto esta migração não roda (upsert mínimo estado='resolvido').

ALTER TABLE public.whatsapp_atendimentos
  ADD COLUMN IF NOT EXISTS desfecho         text,        -- respondido | conciliado | encaminhado | arquivado
  ADD COLUMN IF NOT EXISTS motivo           text,        -- rótulo do motivo de arquivamento / template usado
  ADD COLUMN IF NOT EXISTS regua_bloqueada  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resolvido_em     timestamptz,
  ADD COLUMN IF NOT EXISTS resolvido_por    uuid REFERENCES auth.users(id);

COMMENT ON COLUMN public.whatsapp_atendimentos.desfecho        IS 'Como a conversa saiu da fila de Pendentes: respondido | conciliado | encaminhado | arquivado.';
COMMENT ON COLUMN public.whatsapp_atendimentos.motivo          IS 'Motivo do arquivamento (Resolvido, Sem ação, Respondido por fora, Spam / engano) ou template de 1 toque usado.';
COMMENT ON COLUMN public.whatsapp_atendimentos.regua_bloqueada IS 'TRUE = número marcado como Spam/engano; a régua/disparos automáticos devem pulá-lo.';

-- Resolvidas mais recentes primeiro (visão "Resolvidas").
CREATE INDEX IF NOT EXISTS idx_wa_atend_resolvido
  ON public.whatsapp_atendimentos (resolvido_em DESC)
  WHERE estado = 'resolvido';

-- Lookup rápido dos números bloqueados pela régua/worker de disparo.
CREATE INDEX IF NOT EXISTS idx_wa_atend_regua_bloqueada
  ON public.whatsapp_atendimentos (telefone)
  WHERE regua_bloqueada = true;
