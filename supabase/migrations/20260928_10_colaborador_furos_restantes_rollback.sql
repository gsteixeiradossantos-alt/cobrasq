-- Rollback de 20260928_10 — volta às definições de produção de 01/10/2026 (antes da 10)
-- e devolve ao blob os valores guardados em config_segredos.

create or replace function public.fn_cobrasq_data_sem_segredos()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if jsonb_typeof(new.data->'config') = 'object' then
    new.data := jsonb_set(new.data, '{config}',
      (new.data->'config') - array['asaasKey','zapsignToken','zapiInstanceId','zapiToken','zapiClientToken','claudeApiKey']);
    if tg_op = 'UPDATE' and not (new.data->'config' ? 'integ') and (old.data->'config' ? 'integ') then
      new.data := jsonb_set(new.data, '{config,integ}', old.data->'config'->'integ');
    end if;
  end if;
  return new;
end $$;

update public.cobrasq_data d
   set data = jsonb_set(jsonb_set(jsonb_set(d.data,
         '{config,whatsapp,apiToken}', to_jsonb(coalesce((select valor from public.config_segredos where chave='whatsappApiToken'), d.data->'config'->'whatsapp'->>'apiToken', '')), true),
         '{config,whatsapp,apiUrl}',   to_jsonb(coalesce((select valor from public.config_segredos where chave='whatsappApiUrl'),   d.data->'config'->'whatsapp'->>'apiUrl', '')), true),
         '{config,senha}',             to_jsonb(coalesce((select valor from public.config_segredos where chave='senhaLegadoHash'),  d.data->'config'->>'senha', '')), true)
 where d.key = 'main';

create or replace function public.arquivar_cliente(p_id uuid, p_motivo text default null::text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
DECLARE
  v_papel text;
BEGIN
  v_papel := public.current_user_papel();
  IF v_papel NOT IN ('proprietario','colaborador') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sem permissão.');
  END IF;

  UPDATE public.clientes
  SET arquivado = true,
      arquivado_em = now(),
      arquivado_motivo = COALESCE(p_motivo, 'arquivado-via-app:' || auth.uid()::text)
  WHERE id = p_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Cliente não encontrado.');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.reativar_cliente(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
DECLARE
  v_papel text;
BEGIN
  v_papel := public.current_user_papel();
  IF v_papel NOT IN ('proprietario','colaborador') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sem permissão.');
  END IF;

  UPDATE public.clientes
  SET arquivado = false,
      arquivado_em = NULL,
      arquivado_motivo = NULL
  WHERE id = p_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Cliente não encontrado.');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.iniciar_investigacao_patrimonial(p_devedor_id uuid, p_documento text default null::text, p_nome text default null::text, p_profundidade_maxima smallint default 2, p_entidades_maximas integer default 80, p_cobranca_id uuid default null::uuid)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_nome text;
  v_doc text;
  v_chave text;
  v_dados jsonb;
  v_cobranca uuid;
begin
  if current_user_papel() not in ('proprietario','colaborador') then
    raise exception 'Sem permissão para iniciar investigação patrimonial';
  end if;
  if p_devedor_id is null then
    -- Avulsa: sem devedor nem cobrança; roda só com o nome/CPF digitados.
    if p_cobranca_id is not null then raise exception 'Cobrança exige devedor'; end if;
  else
  select nome, doc, to_jsonb(devedores) into v_nome, v_doc, v_dados
    from public.devedores
   where id=p_devedor_id
     and (current_user_papel()='proprietario' or cadastrado_por=auth.uid() or assigned_to=auth.uid());
  if not found then raise exception 'Devedor não encontrado ou sem acesso'; end if;
  if p_cobranca_id is not null then
    if not exists (select 1 from public.cobranca_partes cp where cp.cobranca_id=p_cobranca_id and cp.devedor_id=p_devedor_id) then
      raise exception 'Este devedor não é parte da cobrança escolhida';
    end if;
    v_cobranca := p_cobranca_id;
  else
    select cp.cobranca_id into v_cobranca
      from public.cobranca_partes cp
     where cp.devedor_id=p_devedor_id
     order by cp.principal desc, cp.created_at desc
     limit 1;
  end if;
  end if;
  v_nome := coalesce(nullif(btrim(p_nome),''), v_nome);
  v_doc := regexp_replace(coalesce(nullif(btrim(p_documento),''), v_doc, ''), '\D', '', 'g');
  if coalesce(v_nome,'')='' and v_doc='' then raise exception 'Informe nome ou CPF/CNPJ'; end if;
  insert into public.investigacoes_patrimoniais(devedor_id,cobranca_id,documento_consultado,nome_consultado,profundidade_maxima,entidades_maximas,solicitado_por)
  values(p_devedor_id,v_cobranca,nullif(v_doc,''),nullif(v_nome,''),least(greatest(coalesce(p_profundidade_maxima,2),0),4),least(greatest(coalesce(p_entidades_maximas,80),1),500),auth.uid())
  returning id into v_id;
  v_chave := case when v_doc<>'' then v_doc else lower(regexp_replace(public.f_unaccent(coalesce(v_nome,'')), '\s+', ' ', 'g')) end;
  insert into public.investigacao_entidades(investigacao_id,tipo,nome,documento,chave_normalizada,profundidade,confianca,status_verificacao,dados)
  values(v_id, case when length(v_doc)=14 then 'empresa' else 'pessoa' end, v_nome, nullif(v_doc,''), v_chave, 0, 100, 'confirmada', jsonb_build_object(
    'origem','cadastro_cobrasq',
    'endereco',jsonb_build_object(
      'cep',coalesce(v_dados->>'cep',v_dados #>> '{endereco_crm,cep}',v_dados #>> '{metadata,enderecoCrm,cep}'),
      'logradouro',coalesce(v_dados->>'rua',v_dados #>> '{endereco_crm,rua}',v_dados #>> '{metadata,enderecoCrm,rua}'),
      'numero',coalesce(v_dados->>'numero',v_dados #>> '{endereco_crm,numero}',v_dados #>> '{metadata,enderecoCrm,numero}')
    )
  ));
  insert into public.investigacao_eventos(investigacao_id,tipo,mensagem,criado_por)
  values(v_id,'criada',case when p_devedor_id is null then 'Investigação avulsa (sem cadastro) criada pelo CRM; aguardando fontes autorizadas.' else 'Investigação criada pelo CRM; aguardando fontes autorizadas.' end,auth.uid());
  if p_devedor_id is not null then
    insert into public.devedor_eventos(devedor_id,cobranca_id,tipo,payload)
    values(p_devedor_id,v_cobranca,'nota_manual',jsonb_build_object('titulo','Investigação patrimonial iniciada','investigacao_id',v_id,'fonte','CRM'));
  end if;
  return v_id;
end;
$function$;
