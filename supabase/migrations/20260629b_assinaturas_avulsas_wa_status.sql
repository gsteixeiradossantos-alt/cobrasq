-- Rastreio de entrega do WhatsApp no envio avulso de assinatura.
-- Aditiva e idempotente: só ADD COLUMN IF NOT EXISTS, sem mexer em RLS.
-- wa_status: null = não tentado (registros antigos) | 'enviado' | 'sem_whatsapp' | 'falhou'
alter table public.assinaturas_avulsas
  add column if not exists wa_status     text,
  add column if not exists wa_message_id text,
  add column if not exists wa_enviado_em timestamptz;
