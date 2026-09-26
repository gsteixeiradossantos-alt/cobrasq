-- ============================================================================
-- Investigação patrimonial: cobranca_id deixa de receber o id do devedor
--
-- iniciar_investigacao_patrimonial (20260916_01) gravava p_devedor_id em
-- investigacoes_patrimoniais.cobranca_id e em devedor_eventos.cobranca_id, as
-- duas com FK para cobrancas(id). Só funciona nos devedores legado cujo id é
-- igual ao da cobrança (1:1). Em 26/09/2026, 117 de 1.119 devedores não têm
-- cobrança com o mesmo id: para eles o botão "Iniciar Investigação Patrimonial"
-- falha com violação de chave estrangeira.
--
-- Agora a cobrança vem do caminho correto (cobranca_partes, principal primeiro,
-- a mais recente) e fica nula quando o devedor não tem cobrança. Só a função
-- muda; nenhuma tabela ou dado é alterado.
-- ============================================================================

create or replace function public.iniciar_investigacao_patrimonial(
  p_devedor_id uuid,
  p_documento text default null,
  p_nome text default null,
  p_profundidade_maxima smallint default 2,
  p_entidades_maximas integer default 80
) returns uuid
language plpgsql security definer set search_path = public
as $$
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
  select nome, doc, to_jsonb(devedores) into v_nome, v_doc, v_dados
    from public.devedores
   where id=p_devedor_id
     and (current_user_papel()='proprietario' or cadastrado_por=auth.uid() or assigned_to=auth.uid());
  if not found then raise exception 'Devedor não encontrado ou sem acesso'; end if;
  select cp.cobranca_id into v_cobranca
    from public.cobranca_partes cp
   where cp.devedor_id=p_devedor_id
   order by cp.principal desc, cp.created_at desc
   limit 1;
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
  values(v_id,'criada','Investigação criada pelo CRM; aguardando fontes autorizadas.',auth.uid());
  insert into public.devedor_eventos(devedor_id,cobranca_id,tipo,payload)
  values(p_devedor_id,v_cobranca,'nota_manual',jsonb_build_object('titulo','Investigação patrimonial iniciada','investigacao_id',v_id,'fonte','CRM'));
  return v_id;
end;
$$;
revoke all on function public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer) from public, anon;
grant execute on function public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer) to authenticated, service_role;
