-- ============================================================================
-- Dados: Embargos de Terceiro 0000505-91.2022.8.16.0068 na cobrança do processo
-- 0000961-75.2021.8.16.0068 (Valery Verona Alécio / V V Alecio). Pedido do
-- Gustavo, 06/10/2026. Depende de 20261006_01. Localiza a cobrança pelo número
-- principal (não fixa uuid); para se não achar exatamente uma.
-- Rollback: delete ... where numero_processo='0000505-91.2022.8.16.0068' and rotulo='Embargos de Terceiro'.
-- ============================================================================
begin;
do $$
declare n int;
begin
  select count(*) into n from public.cobrancas where numero_processo='0000961-75.2021.8.16.0068';
  if n<>1 then raise exception 'Esperava 1 cobrança com 0000961-75.2021.8.16.0068, achei %', n; end if;
end $$;

insert into public.cobranca_processos_vinculados (cobranca_id, numero_processo, rotulo, monitorar_datajud)
select id, '0000505-91.2022.8.16.0068', 'Embargos de Terceiro', true
from public.cobrancas where numero_processo='0000961-75.2021.8.16.0068'
on conflict do nothing;
commit;
