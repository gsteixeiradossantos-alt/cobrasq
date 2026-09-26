-- Investigação patrimonial avulsa (26/09/2026).
-- A tela "Investigação patrimonial" passa a rodar só com nome e CPF/CNPJ, sem
-- devedor nem cobrança cadastrados. O cadastro fica oferecido depois, opcional.
--  * devedor_id deixa de ser obrigatório (null = avulsa).
--  * iniciar_investigacao_patrimonial aceita p_devedor_id null (mesma assinatura
--    de 20260926_03); com devedor, o comportamento não muda.
--  * Leitura: além do que já via, o colaborador vê as avulsas que ele pediu
--    (solicitado_por). Proprietário continua vendo tudo. As tabelas-filhas
--    (entidades, vínculos, evidências, eventos) seguem a leitura da investigação.

alter table public.investigacoes_patrimoniais alter column devedor_id drop not null;

drop policy if exists investigacoes_patrimoniais_staff_select on public.investigacoes_patrimoniais;
create policy investigacoes_patrimoniais_staff_select on public.investigacoes_patrimoniais for select to authenticated using (
  current_user_papel()='proprietario'
  or (current_user_papel()='colaborador' and (
    exists (select 1 from public.devedores d where d.id=devedor_id and (d.cadastrado_por=auth.uid() or d.assigned_to=auth.uid()))
    or (devedor_id is null and solicitado_por=auth.uid())
  ))
);

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

revoke all on function public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer,uuid) from public, anon;
grant execute on function public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer,uuid) to authenticated, service_role;
