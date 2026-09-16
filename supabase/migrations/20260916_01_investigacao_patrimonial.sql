-- ============================================================================
-- Investigação patrimonial — primeira versão operacional
--
-- Aditiva e deliberadamente separada do cadastro do devedor. Armazena somente
-- resultados de fontes públicas ou de fornecedores aos quais o escritório tenha
-- acesso legítimo. Não contém credenciais, nem habilita acesso a dados sigilosos.
-- Aplicar manualmente, após revisão, no projeto jokbxzhcctcwnbhkhgru.
-- ============================================================================

begin;

create table if not exists public.investigacoes_patrimoniais (
  id uuid primary key default gen_random_uuid(),
  devedor_id uuid not null references public.devedores(id) on delete cascade,
  cobranca_id uuid references public.cobrancas(id) on delete set null,
  documento_consultado text,
  nome_consultado text,
  status text not null default 'pendente'
    check (status in ('pendente','em_andamento','aguardando_acesso','concluida','falhou','cancelada')),
  profundidade_maxima smallint not null default 2 check (profundidade_maxima between 0 and 4),
  entidades_maximas integer not null default 80 check (entidades_maximas between 1 and 500),
  fontes_maximas integer not null default 12 check (fontes_maximas between 1 and 50),
  score_prioridade numeric(5,2) not null default 0 check (score_prioridade between 0 and 100),
  score_componentes jsonb not null default '[]'::jsonb,
  resumo jsonb not null default '{}'::jsonb,
  solicitado_por uuid references public.app_users(id) on delete set null,
  iniciado_em timestamptz,
  concluido_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_investigacoes_patrimoniais_devedor
  on public.investigacoes_patrimoniais(devedor_id, created_at desc);
create index if not exists idx_investigacoes_patrimoniais_fila
  on public.investigacoes_patrimoniais(status, created_at)
  where status in ('pendente','em_andamento');

create table if not exists public.investigacao_fontes (
  codigo text primary key,
  nome text not null,
  categoria text not null check (categoria in ('publica','profissional','judicial','restrita','manual')),
  exige_credencial boolean not null default false,
  exige_autorizacao boolean not null default false,
  ativa boolean not null default true,
  url_documentacao text,
  observacao text,
  created_at timestamptz not null default now()
);

insert into public.investigacao_fontes
  (codigo,nome,categoria,exige_credencial,exige_autorizacao,url_documentacao,observacao)
values
  ('receita_rf','Receita Federal / base CNPJ','publica',false,false,'https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica-cnpj','Usar a carga pública rf_* já disponível no Supabase.'),
  ('brasilapi','BrasilAPI CNPJ','publica',false,false,'https://brasilapi.com.br/docs','Consulta por CNPJ; confirmação cadastral.'),
  ('viacep','ViaCEP','publica',false,false,'https://viacep.com.br/','Valida CEP e logradouro antes de qualquer cruzamento de endereço.'),
  ('djen','DJEN / Comunica CNJ','publica',false,false,'https://comunicaapi.pje.jus.br/','Radar de publicações; confirmar no tribunal antes de uso processual.'),
  ('datajud','DataJud CNJ','publica',false,false,'https://datajud-wiki.cnj.jus.br/','Dados processuais públicos, conforme disponibilidade.'),
  ('pncp','PNCP','publica',false,false,'https://pncp.gov.br/api/consulta','Contratos públicos; contrato não prova saldo a pagar.'),
  ('ieptb','IEPTB / CENPROT','profissional',false,true,'https://www.pesquisaprotesto.com.br/','Consulta manual/autorizada de protestos; resultado não é ativo patrimonial.'),
  ('ri_digital','RI Digital / ONR','profissional',true,true,'https://registradores.onr.org.br/','Pesquisa/certidão imobiliária paga, mediante acesso legítimo.'),
  ('portal_transparencia','Portal da Transparência','publica',true,false,'https://portaldatransparencia.gov.br/api-de-dados','Chave de API quando exigida.'),
  ('escavador','Escavador','profissional',true,false,'https://api.escavador.com/','Ativar apenas com contratação e token do escritório.'),
  ('infosimples','InfoSimples','profissional',true,false,'https://infosimples.com/consultas','Ativar apenas após validar catálogo, custo e base legal.'),
  ('tribunal_autenticado','Consulta judicial autenticada','judicial',true,true,null,'Somente ponto de entrada: exige credencial e autorização legítimas; não automatizar captcha.'),
  ('manual','Inclusão manual verificada','manual',false,false,null,'Evidência anexada ou conferida pelo operador.')
on conflict (codigo) do update set
  nome=excluded.nome, categoria=excluded.categoria, exige_credencial=excluded.exige_credencial,
  exige_autorizacao=excluded.exige_autorizacao, url_documentacao=excluded.url_documentacao,
  observacao=excluded.observacao;

create table if not exists public.investigacao_entidades (
  id uuid primary key default gen_random_uuid(),
  investigacao_id uuid not null references public.investigacoes_patrimoniais(id) on delete cascade,
  tipo text not null check (tipo in ('pessoa','empresa','endereco','telefone_publico','processo','imovel','veiculo','vinculo_rural')),
  nome text,
  documento text,
  chave_normalizada text not null,
  profundidade smallint not null default 0 check (profundidade between 0 and 4),
  confianca smallint not null default 50 check (confianca between 0 and 100),
  status_verificacao text not null default 'pendente' check (status_verificacao in ('pendente','confirmada','pista','descartada')),
  dados jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(investigacao_id, tipo, chave_normalizada)
);
create index if not exists idx_investigacao_entidades_investigacao on public.investigacao_entidades(investigacao_id, profundidade);

create table if not exists public.investigacao_vinculos (
  id uuid primary key default gen_random_uuid(),
  investigacao_id uuid not null references public.investigacoes_patrimoniais(id) on delete cascade,
  origem_entidade_id uuid not null references public.investigacao_entidades(id) on delete cascade,
  destino_entidade_id uuid not null references public.investigacao_entidades(id) on delete cascade,
  tipo text not null,
  confianca smallint not null default 50 check (confianca between 0 and 100),
  justificativa text,
  dados jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  check (origem_entidade_id <> destino_entidade_id),
  unique(investigacao_id, origem_entidade_id, destino_entidade_id, tipo)
);

create table if not exists public.investigacao_evidencias (
  id uuid primary key default gen_random_uuid(),
  investigacao_id uuid not null references public.investigacoes_patrimoniais(id) on delete cascade,
  entidade_id uuid references public.investigacao_entidades(id) on delete cascade,
  vinculo_id uuid references public.investigacao_vinculos(id) on delete cascade,
  fonte_codigo text not null references public.investigacao_fontes(codigo),
  referencia_externa text,
  url text,
  titulo text,
  trecho text,
  obtido_em timestamptz not null default now(),
  confianca smallint not null default 50 check (confianca between 0 and 100),
  dados jsonb not null default '{}'::jsonb,
  hash_conteudo text not null,
  created_at timestamptz not null default now(),
  unique(investigacao_id, fonte_codigo, hash_conteudo)
);
create index if not exists idx_investigacao_evidencias_investigacao on public.investigacao_evidencias(investigacao_id, obtido_em desc);

create table if not exists public.investigacao_eventos (
  id uuid primary key default gen_random_uuid(),
  investigacao_id uuid not null references public.investigacoes_patrimoniais(id) on delete cascade,
  tipo text not null check (tipo in ('criada','fonte_iniciada','fonte_concluida','fonte_nao_conclusiva','limite_atingido','status','nota')),
  mensagem text not null,
  dados jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  criado_por uuid references public.app_users(id) on delete set null
);
create index if not exists idx_investigacao_eventos_investigacao on public.investigacao_eventos(investigacao_id, criado_em desc);

-- O ponto único de entrada do CRM. A fonte de dados e credenciais ficam fora
-- desta função; ela só cria a fila e a âncora, de forma idempotente por clique.
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
begin
  if current_user_papel() not in ('proprietario','colaborador') then
    raise exception 'Sem permissão para iniciar investigação patrimonial';
  end if;
  select nome, doc, to_jsonb(devedores) into v_nome, v_doc, v_dados
    from public.devedores
   where id=p_devedor_id
     and (current_user_papel()='proprietario' or cadastrado_por=auth.uid() or assigned_to=auth.uid());
  if not found then raise exception 'Devedor não encontrado ou sem acesso'; end if;
  v_nome := coalesce(nullif(btrim(p_nome),''), v_nome);
  v_doc := regexp_replace(coalesce(nullif(btrim(p_documento),''), v_doc, ''), '\D', '', 'g');
  if coalesce(v_nome,'')='' and v_doc='' then raise exception 'Informe nome ou CPF/CNPJ'; end if;
  insert into public.investigacoes_patrimoniais(devedor_id,cobranca_id,documento_consultado,nome_consultado,profundidade_maxima,entidades_maximas,solicitado_por)
  values(p_devedor_id,p_devedor_id,nullif(v_doc,''),nullif(v_nome,''),least(greatest(coalesce(p_profundidade_maxima,2),0),4),least(greatest(coalesce(p_entidades_maximas,80),1),500),auth.uid())
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
  values(p_devedor_id,p_devedor_id,'nota_manual',jsonb_build_object('titulo','Investigação patrimonial iniciada','investigacao_id',v_id,'fonte','CRM'));
  return v_id;
end;
$$;
revoke all on function public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer) from public, anon;
grant execute on function public.iniciar_investigacao_patrimonial(uuid,text,text,smallint,integer) to authenticated, service_role;

alter table public.investigacoes_patrimoniais enable row level security;
alter table public.investigacao_fontes enable row level security;
alter table public.investigacao_entidades enable row level security;
alter table public.investigacao_vinculos enable row level security;
alter table public.investigacao_evidencias enable row level security;
alter table public.investigacao_eventos enable row level security;

-- Não há acesso para cedente/devedor. Colaborador só lê investigações de seus casos;
-- inserts de resultado vêm do worker com service_role, nunca do browser.
drop policy if exists investigacoes_patrimoniais_staff_select on public.investigacoes_patrimoniais;
create policy investigacoes_patrimoniais_staff_select on public.investigacoes_patrimoniais for select to authenticated using (
  current_user_papel()='proprietario' or (current_user_papel()='colaborador' and exists (select 1 from public.devedores d where d.id=devedor_id and (d.cadastrado_por=auth.uid() or d.assigned_to=auth.uid())))
);
drop policy if exists investigacoes_patrimoniais_owner_write on public.investigacoes_patrimoniais;
create policy investigacoes_patrimoniais_owner_write on public.investigacoes_patrimoniais for all to authenticated using (current_user_papel()='proprietario') with check (current_user_papel()='proprietario');
drop policy if exists investigacao_fontes_staff_select on public.investigacao_fontes;
create policy investigacao_fontes_staff_select on public.investigacao_fontes for select to authenticated using (current_user_papel() in ('proprietario','colaborador'));
drop policy if exists investigacao_entidades_staff_select on public.investigacao_entidades;
create policy investigacao_entidades_staff_select on public.investigacao_entidades for select to authenticated using (exists (select 1 from public.investigacoes_patrimoniais i where i.id=investigacao_id));
drop policy if exists investigacao_vinculos_staff_select on public.investigacao_vinculos;
create policy investigacao_vinculos_staff_select on public.investigacao_vinculos for select to authenticated using (exists (select 1 from public.investigacoes_patrimoniais i where i.id=investigacao_id));
drop policy if exists investigacao_evidencias_staff_select on public.investigacao_evidencias;
create policy investigacao_evidencias_staff_select on public.investigacao_evidencias for select to authenticated using (exists (select 1 from public.investigacoes_patrimoniais i where i.id=investigacao_id));
drop policy if exists investigacao_eventos_staff_select on public.investigacao_eventos;
create policy investigacao_eventos_staff_select on public.investigacao_eventos for select to authenticated using (exists (select 1 from public.investigacoes_patrimoniais i where i.id=investigacao_id));

drop trigger if exists trg_investigacoes_patrimoniais_updated_at on public.investigacoes_patrimoniais;
create trigger trg_investigacoes_patrimoniais_updated_at before update on public.investigacoes_patrimoniais for each row execute function public.set_updated_at();
drop trigger if exists trg_investigacao_entidades_updated_at on public.investigacao_entidades;
create trigger trg_investigacao_entidades_updated_at before update on public.investigacao_entidades for each row execute function public.set_updated_at();

commit;
