-- Rollback de 20261019_bancada_conferencia.sql (apaga as respostas dos clientes junto).
drop function if exists public.cedente_responder_conferencia(uuid,text);
drop table if exists public.conferencia_perguntas;
drop table if exists public.conferencia_itens;
