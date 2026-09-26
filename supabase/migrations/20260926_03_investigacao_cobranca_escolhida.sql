-- Investigação patrimonial pela cobrança (26/09/2026).
-- A tela "Investigação patrimonial" parte da cobrança: o usuário escolhe a
-- cobrança e, dentro dela, quais devedores/envolvidos investigar. A função passa a
-- receber p_cobranca_id e grava a investigação nessa cobrança, conferindo antes
-- que o devedor é parte dela (cobranca_partes). Sem p_cobranca_id (ficha do
-- devedor) continua escolhendo sozinha, como em 20260926_01.
--
-- A assinatura muda (parâmetro novo): a versão de 5 parâmetros é removida para
-- não haver duas funções com o mesmo nome e chamada ambígua via PostgREST.

drop function if exists public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer);

create or replace function public.iniciar_investigacao_patrimonial(
  p_devedor_id uuid,
  p_documento text default null,
  p_nome text default null,
  p_profundidade_maxima smallint default 2,
  p_entidades_maximas integer default 80,
  p_cobranca_id uuid default null
)
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
$function$;

revoke all on function public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer,uuid) from public, anon;
grant execute on function public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer,uuid) to authenticated, service_role;
