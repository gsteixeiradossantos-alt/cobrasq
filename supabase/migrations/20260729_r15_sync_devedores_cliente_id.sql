-- JÁ APLICADO EM PROD (2026-07-29, via MCP). NÃO rodar db push.
-- R-15: devedores.cliente_id ficava nulo quando o fluxo gravava o credor só em
-- cobrancas (26 casos em 8 credores em 2026-07-29). Cura definitiva (lição R-17):
-- trigger mantém a cópia; backfill conserta o estoque. SECURITY DEFINER para o
-- caminho da tela não esbarrar na RLS de devedores (lição R-18).

create or replace function public.fn_sync_devedor_cliente_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.cliente_id is not null then
    update public.devedores d
       set cliente_id = new.cliente_id
     where d.id = new.id
       and d.cliente_id is distinct from new.cliente_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_sync_devedor_cliente_id() from public, anon, authenticated;

drop trigger if exists trg_cobrancas_sync_devedor_cliente on public.cobrancas;
create trigger trg_cobrancas_sync_devedor_cliente
  after insert or update of cliente_id on public.cobrancas
  for each row execute function public.fn_sync_devedor_cliente_id();

-- Backfill do estoque (26 linhas em 2026-07-29)
update public.devedores d
   set cliente_id = c.cliente_id
  from public.cobrancas c
 where c.id = d.id
   and c.cliente_id is not null
   and d.cliente_id is null;
