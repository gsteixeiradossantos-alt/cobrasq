-- Rollback de 20260909_wa_lid_map.sql
--
-- ATENCAO: o backfill de telefones NAO e desfeito. Ele reescreveu
-- `crm_mensagens_status.telefone_enviado` e `crm_mensagens_recebidas.telefone`
-- para o telefone real; o valor original continua disponivel no payload cru
-- (`raw_payload ->> 'phone'` / `raw ->> 'phone'`) e, nas saidas, na coluna
-- `lid`. Reverter isso significaria voltar a quebrar a fila de pendentes, por
-- isso nao ha comando aqui — se for mesmo necessario, refaca a partir do raw.

begin;

drop trigger if exists trg_wa_lid_map on public.crm_mensagens_recebidas;
drop function if exists public.wa_lid_map_upsert();
drop table if exists public.wa_lid_map;

-- A coluna fica: e so auditoria e nao atrapalha o comportamento antigo.
-- alter table public.crm_mensagens_status drop column if exists lid;

commit;
