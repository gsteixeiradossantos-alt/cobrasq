-- Premium Start — Consultoria com franquia (1 dúvida/mês; excedente cobrado à parte).
-- Tabela das consultas + RPCs (padrão ref_id, como cedente_meu_cliente/cedente_set_logo).
-- A notificação WhatsApp p/ o escritório reusa a Edge `enviar-whatsapp` (chamada do front).
-- Aplicar manual no SQL Editor. Idempotente.

create table if not exists public.consultas_premium (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references public.clientes(id),
  criado_em     timestamptz not null default now(),
  assunto       text not null,
  mensagem      text not null,
  status        text not null default 'aberta',     -- aberta | respondida
  excedente     boolean not null default false,     -- true = além da 1 inclusa no mês
  respondida_em timestamptz,
  resposta      text
);
create index if not exists idx_consultas_premium_cliente on public.consultas_premium(cliente_id, criado_em desc);

alter table public.consultas_premium enable row level security;

-- Cedente vê só as próprias (vínculo real app_users.ref_id -> clientes.id).
drop policy if exists consultas_cedente_sel on public.consultas_premium;
create policy consultas_cedente_sel on public.consultas_premium
  for select to authenticated
  using (
    cliente_id in (
      select au.ref_id::uuid from public.app_users au
      where au.id = auth.uid() and au.papel = 'cedente'
        and coalesce(au.ativo, true) and au.ref_id ~ '^[0-9a-fA-F-]{36}$'
    )
  );

-- Staff (proprietário/colaborador) vê e responde tudo.
drop policy if exists consultas_staff_all on public.consultas_premium;
create policy consultas_staff_all on public.consultas_premium
  for all to authenticated
  using (current_user_papel() in ('proprietario','colaborador'))
  with check (current_user_papel() in ('proprietario','colaborador'));

-- INSERT é só pela RPC (controla a franquia). Cedente não tem policy de INSERT direto.

create or replace function public.cedente_nova_consulta(p_assunto text, p_mensagem text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ref text; v_cli uuid; v_usadas int; v_exc boolean; v_id uuid; v_nome text;
begin
  if coalesce(btrim(p_assunto),'')='' or coalesce(btrim(p_mensagem),'')='' then
    raise exception 'Informe o assunto e a mensagem.';
  end if;
  select ref_id into v_ref from public.app_users
    where id = auth.uid() and papel = 'cedente' and coalesce(ativo,true)
      and ref_id ~ '^[0-9a-fA-F-]{36}$';
  if v_ref is null then raise exception 'Sem cliente vinculado a este acesso.'; end if;
  v_cli := v_ref::uuid;
  select count(*) into v_usadas from public.consultas_premium
    where cliente_id = v_cli and criado_em >= date_trunc('month', now());
  v_exc := v_usadas >= 1;  -- franquia: 1 consulta/mês inclusa
  select nome into v_nome from public.clientes where id = v_cli;
  insert into public.consultas_premium(cliente_id, assunto, mensagem, excedente)
    values (v_cli, left(btrim(p_assunto),200), left(btrim(p_mensagem),4000), v_exc)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'usadas', v_usadas+1, 'limite', 1,
                            'excedente', v_exc, 'clienteNome', coalesce(v_nome,''));
end; $$;
revoke all on function public.cedente_nova_consulta(text,text) from public;
grant execute on function public.cedente_nova_consulta(text,text) to authenticated;

create or replace function public.cedente_consultas_status()
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object('usadas', c, 'limite', 1, 'restantes', greatest(0, 1 - c))
  from (
    select count(*)::int c from public.consultas_premium
    where cliente_id = (
        select au.ref_id::uuid from public.app_users au
        where au.id = auth.uid() and au.papel = 'cedente'
          and coalesce(au.ativo,true) and au.ref_id ~ '^[0-9a-fA-F-]{36}$' limit 1)
      and criado_em >= date_trunc('month', now())
  ) s;
$$;
revoke all on function public.cedente_consultas_status() from public;
grant execute on function public.cedente_consultas_status() to authenticated;
