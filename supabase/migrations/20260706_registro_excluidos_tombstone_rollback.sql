-- Rollback da lápide anti-ressurreição (20260706_registro_excluidos_tombstone.sql).
-- Remove os triggers e a função; a tabela registro_excluidos é preservada por padrão
-- (é histórico auditável). Descomente o DROP TABLE se quiser removê-la também.

drop trigger if exists trg_bloqueia_ressurreicao on public.clientes;
drop trigger if exists trg_bloqueia_ressurreicao on public.devedores;
drop function if exists public.fn_bloqueia_ressurreicao();

-- drop table if exists public.registro_excluidos;
