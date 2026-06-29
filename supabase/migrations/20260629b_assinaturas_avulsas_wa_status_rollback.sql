-- Rollback de 20260629b_assinaturas_avulsas_wa_status.sql
alter table public.assinaturas_avulsas
  drop column if exists wa_status,
  drop column if exists wa_message_id,
  drop column if exists wa_enviado_em;
