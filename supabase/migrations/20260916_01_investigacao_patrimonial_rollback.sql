begin;
drop function if exists public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer);
drop table if exists public.investigacao_eventos;
drop table if exists public.investigacao_evidencias;
drop table if exists public.investigacao_vinculos;
drop table if exists public.investigacao_entidades;
drop table if exists public.investigacao_fontes;
drop table if exists public.investigacoes_patrimoniais;
commit;
