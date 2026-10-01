-- ============================================================================
-- 20260928_07 — colaborador só nos casos atribuídos a ele; só o proprietário apaga
-- NÃO APLICADA. Rollback: 20260928_07_colaborador_so_casos_atribuidos_rollback.sql
--
-- Antes: as policies *_colaborador_owned liberavam ALL (inclusive DELETE) quando
-- `cadastrado_por = uid OR assigned_to = uid` — quem cadastrou continuava vendo e
-- apagando o caso mesmo depois de transferido. Agora:
--   • cobrancas: SELECT/INSERT/UPDATE com assigned_to = uid; sem DELETE.
--   • devedores: SELECT se assigned_to = uid ou ligado (cobranca_partes) a cobrança
--     atribuída; INSERT com assigned_to = uid; UPDATE só pelo vínculo cobranca_partes
--     com cobrança atribuída; sem DELETE.
--   • cobranca_partes / cobranca_terceiros: pela cobrança atribuída, COM DELETE — a
--     edição do caso no painel apaga e reinsere as partes (index.html, salvar caso).
--   • devedor_eventos, repasses_cliente, acordos: pela cobrança atribuída (acordo
--     legado sem cobranca_id: pelo devedor visível); sem DELETE.
--   • trigger BEFORE INSERT em cobrancas/devedores: colaborador que deixa
--     assigned_to nulo vira o responsável (senão o próprio INSERT ... RETURNING falha).
-- O proprietário segue nas *_proprietario_all (acordos ganha a sua; antes era staff_all).
-- Transferir caso para outra pessoa passa a ser só do proprietário (WITH CHECK).
-- Documentos: doc_* já usa pode_ver_devedor (devedores.assigned_to) — sem mudança.
-- ============================================================================

-- ── helpers (security definer: evita recursão de RLS entre as tabelas) ─────────
create or replace function public.colab_cobranca_ok(p_cobranca uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.current_user_papel() = 'colaborador'
     and exists (select 1 from public.cobrancas c
                  where c.id = p_cobranca and c.assigned_to = auth.uid());
$$;

create or replace function public.colab_devedor_parte_ok(p_devedor uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.current_user_papel() = 'colaborador'
     and exists (select 1 from public.cobranca_partes p
                   join public.cobrancas c on c.id = p.cobranca_id
                  where p.devedor_id = p_devedor and c.assigned_to = auth.uid());
$$;

revoke all on function public.colab_cobranca_ok(uuid) from public, anon;
revoke all on function public.colab_devedor_parte_ok(uuid) from public, anon;
grant execute on function public.colab_cobranca_ok(uuid) to authenticated;
grant execute on function public.colab_devedor_parte_ok(uuid) to authenticated;

-- ── assigned_to padrão no INSERT do colaborador ─────────────────────────────────
create or replace function public.fn_colaborador_assigned_default()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.assigned_to is null and public.current_user_papel() = 'colaborador' then
    new.assigned_to := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists trg_cobrancas_assigned_default on public.cobrancas;
create trigger trg_cobrancas_assigned_default
  before insert on public.cobrancas
  for each row execute function public.fn_colaborador_assigned_default();

drop trigger if exists trg_devedores_assigned_default on public.devedores;
create trigger trg_devedores_assigned_default
  before insert on public.devedores
  for each row execute function public.fn_colaborador_assigned_default();

-- ── cobrancas ──────────────────────────────────────────────────────────────────
drop policy if exists cobrancas_colaborador_owned on public.cobrancas;
drop policy if exists cobrancas_colaborador_select on public.cobrancas;
drop policy if exists cobrancas_colaborador_insert on public.cobrancas;
drop policy if exists cobrancas_colaborador_update on public.cobrancas;
create policy cobrancas_colaborador_select on public.cobrancas for select to authenticated
  using (public.current_user_papel() = 'colaborador' and assigned_to = auth.uid());
create policy cobrancas_colaborador_insert on public.cobrancas for insert to authenticated
  with check (public.current_user_papel() = 'colaborador' and assigned_to = auth.uid());
create policy cobrancas_colaborador_update on public.cobrancas for update to authenticated
  using (public.current_user_papel() = 'colaborador' and assigned_to = auth.uid())
  with check (public.current_user_papel() = 'colaborador' and assigned_to = auth.uid());

-- ── devedores ──────────────────────────────────────────────────────────────────
drop policy if exists devedores_colaborador_owned on public.devedores;
drop policy if exists devedores_colaborador_parte on public.devedores;
drop policy if exists devedores_colaborador_select on public.devedores;
drop policy if exists devedores_colaborador_insert on public.devedores;
drop policy if exists devedores_colaborador_update on public.devedores;
create policy devedores_colaborador_select on public.devedores for select to authenticated
  using (public.current_user_papel() = 'colaborador'
         and (assigned_to = auth.uid() or public.colab_devedor_parte_ok(id)));
create policy devedores_colaborador_insert on public.devedores for insert to authenticated
  with check (public.current_user_papel() = 'colaborador' and assigned_to = auth.uid());
create policy devedores_colaborador_update on public.devedores for update to authenticated
  using (public.colab_devedor_parte_ok(id))
  with check (public.colab_devedor_parte_ok(id));

-- ── cobranca_partes / cobranca_terceiros (com DELETE: edição do caso) ───────────
drop policy if exists cobranca_partes_colaborador_owned on public.cobranca_partes;
create policy cobranca_partes_colaborador_owned on public.cobranca_partes for all to authenticated
  using (public.colab_cobranca_ok(cobranca_id))
  with check (public.colab_cobranca_ok(cobranca_id));

drop policy if exists cobranca_terceiros_colaborador_owned on public.cobranca_terceiros;
create policy cobranca_terceiros_colaborador_owned on public.cobranca_terceiros for all to authenticated
  using (public.colab_cobranca_ok(cobranca_id))
  with check (public.colab_cobranca_ok(cobranca_id));

-- ── devedor_eventos ────────────────────────────────────────────────────────────
drop policy if exists eventos_colaborador_owned on public.devedor_eventos;
drop policy if exists eventos_colaborador_select on public.devedor_eventos;
drop policy if exists eventos_colaborador_insert on public.devedor_eventos;
drop policy if exists eventos_colaborador_update on public.devedor_eventos;
create policy eventos_colaborador_select on public.devedor_eventos for select to authenticated
  using (public.colab_cobranca_ok(cobranca_id)
         or (cobranca_id is null and public.colab_devedor_parte_ok(devedor_id)));
create policy eventos_colaborador_insert on public.devedor_eventos for insert to authenticated
  with check (public.colab_cobranca_ok(cobranca_id)
              or (cobranca_id is null and public.colab_devedor_parte_ok(devedor_id)));
create policy eventos_colaborador_update on public.devedor_eventos for update to authenticated
  using (public.colab_cobranca_ok(cobranca_id)
         or (cobranca_id is null and public.colab_devedor_parte_ok(devedor_id)))
  with check (public.colab_cobranca_ok(cobranca_id)
              or (cobranca_id is null and public.colab_devedor_parte_ok(devedor_id)));

-- ── repasses_cliente ───────────────────────────────────────────────────────────
drop policy if exists repasses_colaborador_owned on public.repasses_cliente;
drop policy if exists repasses_colaborador_select on public.repasses_cliente;
drop policy if exists repasses_colaborador_insert on public.repasses_cliente;
drop policy if exists repasses_colaborador_update on public.repasses_cliente;
create policy repasses_colaborador_select on public.repasses_cliente for select to authenticated
  using (public.colab_cobranca_ok(cobranca_id));
create policy repasses_colaborador_insert on public.repasses_cliente for insert to authenticated
  with check (public.colab_cobranca_ok(cobranca_id));
create policy repasses_colaborador_update on public.repasses_cliente for update to authenticated
  using (public.colab_cobranca_ok(cobranca_id))
  with check (public.colab_cobranca_ok(cobranca_id));

-- ── acordos (era staff_all) ────────────────────────────────────────────────────
drop policy if exists acordos_staff_all on public.acordos;
drop policy if exists acordos_proprietario_all on public.acordos;
drop policy if exists acordos_colaborador_select on public.acordos;
drop policy if exists acordos_colaborador_insert on public.acordos;
drop policy if exists acordos_colaborador_update on public.acordos;
create policy acordos_proprietario_all on public.acordos for all to authenticated
  using (public.current_user_papel() = 'proprietario')
  with check (public.current_user_papel() = 'proprietario');
create policy acordos_colaborador_select on public.acordos for select to authenticated
  using (public.colab_cobranca_ok(cobranca_id)
         or (cobranca_id is null and public.colab_devedor_parte_ok(devedor_id)));
create policy acordos_colaborador_insert on public.acordos for insert to authenticated
  with check (public.colab_cobranca_ok(cobranca_id)
              or (cobranca_id is null and public.colab_devedor_parte_ok(devedor_id)));
create policy acordos_colaborador_update on public.acordos for update to authenticated
  using (public.colab_cobranca_ok(cobranca_id)
         or (cobranca_id is null and public.colab_devedor_parte_ok(devedor_id)))
  with check (public.colab_cobranca_ok(cobranca_id)
              or (cobranca_id is null and public.colab_devedor_parte_ok(devedor_id)));
