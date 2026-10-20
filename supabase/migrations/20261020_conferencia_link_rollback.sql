-- Rollback de 20261020_conferencia_link.sql. Os links param de abrir na hora; as respostas
-- já dadas pelo link ficam (só perdem a marca respondida_link).
drop function if exists public.conferencia_responder_link(text,uuid,text);
drop function if exists public.conferencia_por_link(text);
drop function if exists public._conferencia_link_ativo(text);
alter table public.conferencia_perguntas drop column if exists respondida_link;
drop table if exists public.conferencia_links;
-- cedente_responder_conferencia volta à versão de 20261019 (sem respondida_link):
-- reaplicar o bloco "resposta do cliente" de 20261019_bancada_conferencia.sql.
