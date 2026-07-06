-- ANTI-RESSURREIÇÃO (achado da auditoria 2026-07-06):
-- Clientes/devedores excluídos "voltam" (ex.: os cadastros de teste "lalala" e "—").
-- Causa: o save() do painel regrava a LISTA INTEIRA de DB.clientes/DB.devedores por
-- cima do banco (flushRelational -> upsert onConflict:id). Uma aba/dispositivo com
-- estado velho reinsere linhas que já tinham sido apagadas em outra sessão.
--
-- Solução (lápide + trigger): uma tabela `registro_excluidos` guarda o id de tudo que
-- foi apagado de propósito; um trigger BEFORE INSERT em clientes/devedores CANCELA o
-- INSERT de qualquer id tombado. Vale para QUALQUER aba/dispositivo, mesmo com lista
-- velha em memória — a ressurreição morre na origem (o banco).
--
-- Por que RETURN NULL (pula a linha) e não RAISE EXCEPTION: o save faz upsert em LOTE.
-- Um RAISE abortaria o batch inteiro (uma única linha tombada travaria TODOS os saves
-- daquela aba). RETURN NULL descarta só a linha tombada e deixa o resto passar.
-- Recriação legítima do mesmo id (raro): o dono remove a lápide antes (DELETE, abaixo).
--
-- Aplicar em prod: Supabase dashboard -> SQL Editor.

create table if not exists public.registro_excluidos (
  id           uuid        not null,
  tipo         text        not null check (tipo in ('cliente','devedor')),
  excluido_em  timestamptz not null default now(),
  excluido_por uuid,
  motivo       text,
  primary key (tipo, id)
);

alter table public.registro_excluidos enable row level security;

-- Staff (gestor/colaborador) lê e grava lápides; só o dono remove (recriação legítima).
drop policy if exists registro_excluidos_staff_select on public.registro_excluidos;
create policy registro_excluidos_staff_select on public.registro_excluidos
  for select to authenticated
  using (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists registro_excluidos_staff_insert on public.registro_excluidos;
create policy registro_excluidos_staff_insert on public.registro_excluidos
  for insert to authenticated
  with check (current_user_papel() = any (array['proprietario','colaborador']));

drop policy if exists registro_excluidos_owner_delete on public.registro_excluidos;
create policy registro_excluidos_owner_delete on public.registro_excluidos
  for delete to authenticated
  using (current_user_papel() = 'proprietario');

grant select, insert, delete on public.registro_excluidos to authenticated;

-- Trigger que bloqueia a reinserção de um id já excluído.
-- SECURITY DEFINER: precisa ler registro_excluidos independente da RLS de quem grava.
create or replace function public.fn_bloqueia_ressurreicao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo text := case tg_table_name
                   when 'clientes'  then 'cliente'
                   when 'devedores' then 'devedor'
                   else null end;
begin
  if v_tipo is not null
     and exists (select 1 from public.registro_excluidos r
                  where r.tipo = v_tipo and r.id = new.id) then
    return null; -- id tombado: pula o INSERT silenciosamente (não aborta o batch)
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bloqueia_ressurreicao on public.clientes;
create trigger trg_bloqueia_ressurreicao
  before insert on public.clientes
  for each row execute function public.fn_bloqueia_ressurreicao();

drop trigger if exists trg_bloqueia_ressurreicao on public.devedores;
create trigger trg_bloqueia_ressurreicao
  before insert on public.devedores
  for each row execute function public.fn_bloqueia_ressurreicao();
