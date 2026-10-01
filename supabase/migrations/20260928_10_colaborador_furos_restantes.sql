-- ============================================================================
-- 20260928_10 — furos que a simulação de RLS achou depois da 02–09 (01/10/2026)
-- Rollback: 20260928_10_colaborador_furos_restantes_rollback.sql
--
-- 1. O blob ainda guardava config.whatsapp.apiToken (= zapiToken) e
--    config.whatsapp.apiUrl (contém instância + token), da tela antiga de
--    configuração do WhatsApp, e config.senha (hash do login offline do gestor).
--    O colaborador lê o blob. O envio real usa as variáveis da Vercel; esses campos
--    só acendiam o "configurado" da tela velha. Vão para config_segredos (só o
--    proprietário lê) e o trigger fn_cobrasq_data_sem_segredos passa a tirá-los
--    de qualquer gravação. Decisão do Gustavo em 01/10/2026: "Apagar e travar" e
--    apagar a senha antiga (perde-se só o login sem internet).
-- 2. arquivar_cliente / reativar_cliente (security definer) aceitavam colaborador —
--    escrita em clientes que a 09 deixou só para o proprietário. Agora só o dono.
-- 3. iniciar_investigacao_patrimonial: colaborador só investiga devedor de caso
--    atribuído a ele (antes: cadastrado_por, mesmo após transferido). Investigação
--    avulsa (sem devedor) fica só com o proprietário.
-- ============================================================================

-- 1a. guarda os valores (não sobrescreve)
insert into public.config_segredos (chave, valor, atualizado_por)
select v.chave, v.valor, null
  from public.cobrasq_data d,
       lateral (values
         ('whatsappApiToken', d.data->'config'->'whatsapp'->>'apiToken'),
         ('whatsappApiUrl',   d.data->'config'->'whatsapp'->>'apiUrl'),
         ('senhaLegadoHash',  d.data->'config'->>'senha')) v(chave, valor)
 where d.key = 'main' and coalesce(v.valor, '') <> ''
on conflict (chave) do nothing;

-- 1b. trigger tira também whatsapp.apiToken / whatsapp.apiUrl / senha
create or replace function public.fn_cobrasq_data_sem_segredos()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if jsonb_typeof(new.data->'config') = 'object' then
    new.data := jsonb_set(new.data, '{config}',
      (new.data->'config') - array['asaasKey','zapsignToken','zapiInstanceId','zapiToken','zapiClientToken','claudeApiKey','senha']);
    if jsonb_typeof(new.data->'config'->'whatsapp') = 'object' then
      new.data := jsonb_set(new.data, '{config,whatsapp}',
        (new.data->'config'->'whatsapp') - array['apiToken','apiUrl']);
    end if;
    -- aba antiga grava config sem integ: mantém o que o banco já tinha
    if tg_op = 'UPDATE' and not (new.data->'config' ? 'integ') and (old.data->'config' ? 'integ') then
      new.data := jsonb_set(new.data, '{config,integ}', old.data->'config'->'integ');
    end if;
  end if;
  return new;
end $$;

-- 1c. passa o blob atual pelo trigger
update public.cobrasq_data set data = data where key = 'main';

-- 2. arquivar / reativar credor: só o proprietário
create or replace function public.arquivar_cliente(p_id uuid, p_motivo text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(public.current_user_papel(), '') <> 'proprietario' then
    return jsonb_build_object('ok', false, 'erro', 'Sem permissão.');
  end if;

  update public.clientes
  set arquivado = true,
      arquivado_em = now(),
      arquivado_motivo = coalesce(p_motivo, 'arquivado-via-app:' || auth.uid()::text)
  where id = p_id;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'Cliente não encontrado.');
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.reativar_cliente(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(public.current_user_papel(), '') <> 'proprietario' then
    return jsonb_build_object('ok', false, 'erro', 'Sem permissão.');
  end if;

  update public.clientes
  set arquivado = false,
      arquivado_em = null,
      arquivado_motivo = null
  where id = p_id;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'Cliente não encontrado.');
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

-- 3. investigação patrimonial: colaborador só nos casos atribuídos; avulsa só o dono
create or replace function public.iniciar_investigacao_patrimonial(p_devedor_id uuid, p_documento text default null::text, p_nome text default null::text, p_profundidade_maxima smallint default 2, p_entidades_maximas integer default 80, p_cobranca_id uuid default null::uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
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
    -- Avulsa: sem devedor nem cobrança; roda só com o nome/CPF digitados. Só o proprietário.
    if current_user_papel() <> 'proprietario' then
      raise exception 'Investigação avulsa (sem devedor cadastrado) é só do proprietário';
    end if;
    if p_cobranca_id is not null then raise exception 'Cobrança exige devedor'; end if;
  else
  select nome, doc, to_jsonb(devedores) into v_nome, v_doc, v_dados
    from public.devedores
   where id=p_devedor_id
     and (current_user_papel()='proprietario' or assigned_to=auth.uid() or public.colab_devedor_parte_ok(id));
  if not found then raise exception 'Devedor não encontrado ou sem acesso'; end if;
  if p_cobranca_id is not null then
    if not exists (select 1 from public.cobranca_partes cp where cp.cobranca_id=p_cobranca_id and cp.devedor_id=p_devedor_id) then
      raise exception 'Este devedor não é parte da cobrança escolhida';
    end if;
    if current_user_papel() <> 'proprietario' and not public.colab_cobranca_ok(p_cobranca_id) then
      raise exception 'Cobrança não atribuída a você';
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
