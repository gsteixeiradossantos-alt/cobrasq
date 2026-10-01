-- ============================================================================
-- 20260928_02 — contador diário de uso da IA (/api/claude) por usuário
-- NÃO APLICADA. Aditiva. Rollback: 20260928_02_ia_uso_diario_rollback.sql
--
-- /api/claude aceitava qualquer sessão válida, sem teto de quantidade. Agora o
-- proxy confere app_users (equipe ativa) e, para o colaborador, lê
-- app_users.ia_limite_dia (padrão 0 = IA bloqueada — decisão do Gustavo em
-- 01/10/2026: "bloqueia tudo de ia, se precisar vou liberando") e chama
-- ia_uso_registrar(p_user, p_limite): incrementa o contador do dia (fuso de
-- Brasília) de forma atômica e devolve ok=false quando passaria do limite.
-- ia_limite_dia entra na trava de privilégio (20260928_04): só o proprietário altera.
-- Só o service role (o proxy na Vercel) executa a RPC; a tabela não tem policy
-- para authenticated/anon — só o proprietário lê, para acompanhar o uso.
-- ============================================================================

alter table public.app_users add column if not exists ia_limite_dia integer not null default 0
  check (ia_limite_dia >= 0);
comment on column public.app_users.ia_limite_dia is
  'Pedidos de IA (/api/claude) por dia para o colaborador. 0 = bloqueado. Proprietário não tem teto. Só o proprietário altera.';

create table if not exists public.ia_uso_diario (
  user_id   uuid not null references public.app_users(id) on delete cascade,
  dia       date not null,
  chamadas  integer not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (user_id, dia)
);

alter table public.ia_uso_diario enable row level security;

drop policy if exists ia_uso_diario_owner_select on public.ia_uso_diario;
create policy ia_uso_diario_owner_select on public.ia_uso_diario
  for select to authenticated
  using (public.current_user_papel() = 'proprietario');

revoke all on public.ia_uso_diario from anon;
revoke insert, update, delete on public.ia_uso_diario from authenticated;

create or replace function public.ia_uso_registrar(p_user uuid, p_limite integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
  v_n   integer;
begin
  insert into public.ia_uso_diario as u (user_id, dia, chamadas)
  values (p_user, v_dia, 1)
  on conflict (user_id, dia) do update
     set chamadas = u.chamadas + 1, atualizado_em = now()
   where u.chamadas < p_limite
  returning chamadas into v_n;

  if v_n is null then
    -- já estava no limite: o UPDATE não aconteceu
    select chamadas into v_n from public.ia_uso_diario where user_id = p_user and dia = v_dia;
    return jsonb_build_object('ok', false, 'chamadas', v_n, 'limite', p_limite);
  end if;
  return jsonb_build_object('ok', true, 'chamadas', v_n, 'limite', p_limite);
end;
$$;

revoke all on function public.ia_uso_registrar(uuid, integer) from public, anon, authenticated;
grant execute on function public.ia_uso_registrar(uuid, integer) to service_role;
