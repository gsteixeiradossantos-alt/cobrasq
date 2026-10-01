-- Rollback de 20260928_05 — cobrasq_merge como estava em produção em 28/09/2026 (sem guarda).
create or replace function public.cobrasq_merge(p jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_data jsonb;
  v_key  text;
  v_spec jsonb;
  v_arr  jsonb;
  v_up   jsonb;
  v_del  jsonb;
  v_ts   timestamptz;
begin
  select data into v_data from public.cobrasq_data where key = 'main' for update;
  if v_data is null then
    return jsonb_build_object('ok', false, 'erro', 'blob não encontrado');
  end if;

  if p ? 'replace' then
    for v_key in select jsonb_object_keys(p->'replace') loop
      v_data := jsonb_set(v_data, array[v_key], p->'replace'->v_key, true);
    end loop;
  end if;

  if p ? 'colecoes' then
    for v_key in select jsonb_object_keys(p->'colecoes') loop
      v_spec := p->'colecoes'->v_key;
      v_arr  := coalesce(v_data->v_key, '[]'::jsonb);
      v_up   := coalesce(v_spec->'upsert', '[]'::jsonb);
      v_del  := coalesce(v_spec->'delete', '[]'::jsonb);
      select coalesce(jsonb_agg(e), '[]'::jsonb) into v_arr
        from jsonb_array_elements(v_arr) e
       where not (v_del ? coalesce(e->>'id',''))
         and not exists (select 1 from jsonb_array_elements(v_up) u
                          where u->>'id' = e->>'id');
      v_arr := v_arr || v_up;
      v_data := jsonb_set(v_data, array[v_key], v_arr, true);
    end loop;
  end if;

  update public.cobrasq_data set data = v_data, updated_at = now() where key = 'main'
  returning updated_at into v_ts;
  return jsonb_build_object('ok', true, 'updated_at', v_ts);
end $function$;
