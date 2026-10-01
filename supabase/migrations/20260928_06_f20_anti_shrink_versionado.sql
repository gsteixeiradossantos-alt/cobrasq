-- ============================================================================
-- 20260928_06 — F-20 (anti-shrink do blob) versionado
-- JÁ APLICADO EM PRODUÇÃO (criado direto em prod, fora das migrações). Este
-- arquivo só registra a definição vigente em 28/09/2026 e é idempotente: rodar de
-- novo recria a mesma função e o mesmo trigger. Sem rollback (é o estado atual).
--
-- Bloqueia gravação do blob que tire mais de 2 devedores fora de rascunho ou
-- apague o responsável de mais de 3. NÃO protege `config` — isso é da migração
-- de preservação de config (20260928_08).
-- ============================================================================

create or replace function public.fn_cobrasq_data_anti_shrink()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_antes  int; v_depois int; v_resp_antes int; v_resp_depois int;
begin
  select count(*) into v_antes from jsonb_array_elements(coalesce(old.data->'devedores','[]'::jsonb)) d
   where coalesce(d->>'isDraft','') <> 'true';
  select count(*) into v_depois from jsonb_array_elements(coalesce(new.data->'devedores','[]'::jsonb)) d
   where coalesce(d->>'isDraft','') <> 'true';
  if v_depois < v_antes - 2 then
    raise exception 'F-20: gravação bloqueada — removeria % devedores (% → %). Aba desatualizada: recarregue a página (F5).',
      v_antes - v_depois, v_antes, v_depois;
  end if;
  select count(*) into v_resp_antes from jsonb_array_elements(coalesce(old.data->'devedores','[]'::jsonb)) d
   where coalesce(d->>'responsavel','') <> '';
  select count(*) into v_resp_depois from jsonb_array_elements(coalesce(new.data->'devedores','[]'::jsonb)) d
   where coalesce(d->>'responsavel','') <> '';
  if v_resp_depois < v_resp_antes - 3 then
    raise exception 'F-20: gravação bloqueada — apagaria o responsável de % devedores (% → %). Aba desatualizada: recarregue a página (F5).',
      v_resp_antes - v_resp_depois, v_resp_antes, v_resp_depois;
  end if;
  return new;
end $function$;

drop trigger if exists trg_cobrasq_data_anti_shrink on public.cobrasq_data;
create trigger trg_cobrasq_data_anti_shrink
  before update on public.cobrasq_data
  for each row execute function public.fn_cobrasq_data_anti_shrink();
