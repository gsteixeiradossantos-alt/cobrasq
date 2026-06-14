-- RPC chamada pelo n8n logo após criar o documento no ZapSign.
-- Grava o zapsign_doc_id no acordo do devedor (cria o registro se não existir),
-- para que o zapsign-webhook do CRM reconheça o documento quando for assinado.
-- Execução restrita a service_role. Aplicada em produção via MCP em 2026-06-11.
-- Rollback: drop function public.vincular_zapsign_acordo(text,text,text,text,text,integer,text,text);

create or replace function public.vincular_zapsign_acordo(
  p_doc_token          text,
  p_external_id        text default null,
  p_cpf_dev            text default null,
  p_telefone           text default null,
  p_valor_total        text default null,
  p_num_parcelas       integer default null,
  p_data_primeiro_venc text default null,
  p_forma              text default null
) returns jsonb
language plpgsql security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_dev_id    uuid;
  v_acordo_id uuid;
  v_valor     numeric;
  v_venc      date;
  v_cpf text := nullif(regexp_replace(coalesce(p_cpf_dev,''), '\D', '', 'g'), '');
  v_tel text := nullif(right(regexp_replace(coalesce(p_telefone,''), '\D', '', 'g'), 8), '');
begin
  if coalesce(btrim(p_doc_token),'') = '' then
    return jsonb_build_object('ok', false, 'motivo', 'doc_token vazio');
  end if;

  select id into v_acordo_id from acordos where zapsign_doc_id = p_doc_token limit 1;
  if v_acordo_id is not null then
    return jsonb_build_object('ok', true, 'acao', 'ja_vinculado', 'acordo_id', v_acordo_id);
  end if;

  if v_cpf is not null then
    select d.id into v_dev_id from devedores d
     where nullif(regexp_replace(coalesce(d.doc_digits, d.doc, ''), '\D', '', 'g'), '') = v_cpf
     order by d.updated_at desc limit 1;
  end if;
  if v_dev_id is null and v_tel is not null then
    select d.id into v_dev_id from devedores d
     where right(regexp_replace(coalesce(d.telefone,''), '\D', '', 'g'), 8) = v_tel
     order by d.updated_at desc limit 1;
  end if;
  if v_dev_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'devedor não encontrado por CPF/telefone',
                              'cpf', v_cpf, 'tel', v_tel);
  end if;

  begin
    v_valor := nullif(replace(regexp_replace(coalesce(p_valor_total,''), '[^0-9,]', '', 'g'), ',', '.'), '')::numeric;
  exception when others then v_valor := null; end;
  begin
    if p_data_primeiro_venc ~ '^\d{2}/\d{2}/\d{4}$' then
      v_venc := to_date(p_data_primeiro_venc, 'DD/MM/YYYY');
    end if;
  exception when others then v_venc := null; end;

  select id into v_acordo_id from acordos
   where devedor_id = v_dev_id and zapsign_doc_id is null
     and coalesce(status_zapsign,'') <> 'assinado' and status = 'ativo'
   order by created_at desc limit 1;

  if v_acordo_id is not null then
    update acordos
       set zapsign_doc_id = p_doc_token,
           status_zapsign = coalesce(status_zapsign, 'enviado'),
           linha_gsheet   = coalesce(linha_gsheet, p_external_id),
           metadata = coalesce(metadata,'{}'::jsonb)
                      || jsonb_build_object('vinculado_por','n8n','external_id',p_external_id),
           updated_at = now()
     where id = v_acordo_id;
    return jsonb_build_object('ok', true, 'acao', 'atualizado', 'acordo_id', v_acordo_id, 'devedor_id', v_dev_id);
  end if;

  insert into acordos (devedor_id, forma, status, num_parcelas, valor_total, data_primeiro_venc,
                       zapsign_doc_id, status_zapsign, linha_gsheet, metadata)
  values (v_dev_id,
          case when p_forma in ('avista','boleto','cartao','outro') then p_forma else 'boleto' end,
          'ativo', p_num_parcelas, v_valor, v_venc,
          p_doc_token, 'enviado', p_external_id,
          jsonb_build_object('vinculado_por','n8n','external_id',p_external_id))
  returning id into v_acordo_id;

  return jsonb_build_object('ok', true, 'acao', 'criado', 'acordo_id', v_acordo_id, 'devedor_id', v_dev_id);
end $$;

revoke execute on function public.vincular_zapsign_acordo(text,text,text,text,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.vincular_zapsign_acordo(text,text,text,text,text,integer,text,text) to service_role;
