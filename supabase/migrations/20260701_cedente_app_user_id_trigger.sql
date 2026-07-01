-- Blindagem do vínculo cedente↔cliente.
--
-- Problema: TODAS as RLS de leitura do cedente (cobrancas/devedores/repasses/
-- documentos/cobranca_partes/acordos/eventos/provas/intimacoes) escopam por
-- clientes.app_user_id = auth.uid(). O save em lote do staff (flushRelational →
-- upsert de DB.clientes) reenviava app_user_id=null para clientes vindos do blob/
-- importação, ZERANDO o acesso de todos os cedentes de uma vez.
--
-- Vínculo canônico = app_users(ref_id, papel='cedente'). Este trigger re-deriva
-- clientes.app_user_id a partir dele em todo INSERT/UPDATE, de modo que nenhum
-- caminho de escrita (app, import, dedup, blob) consiga quebrar o acesso do cedente.
-- SECURITY DEFINER: o enforcement precisa enxergar app_users independentemente da
-- RLS de quem está gravando (senão o subselect volta NULL e o wipe passaria).

create or replace function public.enforce_cliente_app_user_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid;
begin
  select u.id into v_uid
  from public.app_users u
  where u.papel = 'cedente'
    and u.ref_id = NEW.id::text
    and coalesce(u.ativo, true) = true
  order by u.id
  limit 1;
  -- só força quando há cedente para este cliente; clientes comuns ficam intactos
  if v_uid is not null then
    NEW.app_user_id := v_uid;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_cliente_app_user_id on public.clientes;
create trigger trg_enforce_cliente_app_user_id
before insert or update on public.clientes
for each row execute function public.enforce_cliente_app_user_id();

-- Backfill defensivo e idempotente: re-sincroniza qualquer drift atual.
update public.clientes c
set app_user_id = u.id
from public.app_users u
where u.papel = 'cedente'
  and u.ref_id = c.id::text
  and coalesce(u.ativo, true) = true
  and c.app_user_id is distinct from u.id;
