-- JÁ APLICADO EM PROD (versão 20260612021448). Snapshot reconstruído do catálogo em 2026-07-29. NÃO rodar db push.
-- ============================================================================
-- F-20: trigger anti-encolhimento do blob cobrasq_data. Bloqueia gravação que
-- removeria mais de 2 devedores não-rascunho do array data->'devedores'
-- (sintoma clássico de aba desatualizada sobrescrevendo o blob inteiro).
--
-- NOTA: a definição abaixo é o estado ATUAL de prod, que já incorpora também a
-- proteção de responsáveis adicionada pela migração 20260612170301
-- (f20_trigger_protege_responsaveis) — as duas migrações evoluíram a MESMA
-- função. Ver o arquivo-stub 20260612_f20_trigger_protege_responsaveis.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_cobrasq_data_anti_shrink()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

DROP TRIGGER IF EXISTS trg_cobrasq_data_anti_shrink ON public.cobrasq_data;
CREATE TRIGGER trg_cobrasq_data_anti_shrink
  BEFORE UPDATE ON public.cobrasq_data
  FOR EACH ROW EXECUTE FUNCTION public.fn_cobrasq_data_anti_shrink();
