-- Rollback de 20260928_01_documentos_portal_cliente.sql
-- As colunas ficam (apagar perderia a marcação de compartilhado/pendente); só some o
-- acesso do cedente e a RPC. Para apagar também as colunas, descomente o bloco final.

drop policy if exists documentos_cedente_portal on public.documentos;
drop policy if exists documentos_cedente_portal_select on storage.objects;
drop policy if exists documentos_cedente_portal_insert on storage.objects;
drop function if exists public.cedente_registrar_documento(text,text,text,text,integer,text);
drop function if exists public.cedente_pode_cobranca(text);

-- drop index if exists public.documentos_pendentes_cliente_idx;
-- alter table public.documentos
--   drop constraint if exists documentos_status_aprovacao_check,
--   drop constraint if exists documentos_origem_check,
--   drop column if exists aprovado_em,
--   drop column if exists aprovado_por,
--   drop column if exists status_aprovacao,
--   drop column if exists origem,
--   drop column if exists visivel_cliente;
