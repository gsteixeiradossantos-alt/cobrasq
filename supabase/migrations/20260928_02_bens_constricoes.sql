-- ============================================================================
-- Bens e constrições da cobrança (pedido do Gustavo em 28/09/2026)
--
-- Bem que JÁ está constrito ou averbado no processo — matrícula com AV/R, veículo
-- com Renajud, conta com Sisbajud. É outro objeto que a investigação patrimonial
-- (investigacao_entidades guarda PISTAS de fonte pública, com confiança): aqui
-- cada ato tem número de registro, data, processo CNJ, movimento dos autos e
-- situação. Decisão do Gustavo (28/09/2026): tabela própria; certidão anexada
-- pela aba "Documentos do caso" (categoria nova 'matricula'); só o escritório vê.
--
-- Aditiva. Duas tabelas + categoria nova em documentos. Rollback pareado.
-- ============================================================================

begin;

-- Categoria para a certidão de matrícula / inteiro teor.
alter table public.documentos drop constraint if exists documentos_categoria_check;
alter table public.documentos add constraint documentos_categoria_check
  check (categoria = any (array['contrato','nota-promissoria','cheque','duplicata','boleto','comprovante','repasse','acordo-assinado','peticao','procuracao','calculo','devolucao-documento','matricula','outros']));

create table if not exists public.bens_cobranca (
  id uuid primary key default gen_random_uuid(),
  cobranca_id uuid not null references public.cobrancas(id) on delete cascade,
  -- Devedor dono do bem segundo o cadastro (principal ou corresponsável).
  devedor_id uuid references public.devedores(id) on delete set null,
  tipo text not null check (tipo in ('imovel','veiculo','conta','cotas','outro')),
  descricao text,
  -- Imóvel
  matricula text,
  cartorio text,
  comarca text,
  endereco text,
  area_m2 numeric(14,2),
  -- Veículo
  placa text,
  renavam text,
  -- Conta / cotas / outro: banco, CNPJ da sociedade, etc.
  identificacao text,
  -- [{nome, doc, fracao, ato}] — proprietários segundo o registro.
  proprietarios jsonb not null default '[]'::jsonb check (jsonb_typeof(proprietarios)='array'),
  -- [{tipo, credor, ato, data, situacao, obs}] — hipoteca, alienação fiduciária,
  -- penhoras de outros processos.
  onus_terceiros jsonb not null default '[]'::jsonb check (jsonb_typeof(onus_terceiros)='array'),
  avaliacao_valor numeric(14,2),
  avaliacao_data date,
  avaliacao_fonte text,
  certidao_documento_id uuid references public.documentos(id) on delete set null,
  certidao_data date,
  observacao text,
  origem text not null default 'manual' check (origem in ('manual','skill')),
  criado_por uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_bens_cobranca_cobranca on public.bens_cobranca(cobranca_id);
create index if not exists idx_bens_cobranca_devedor on public.bens_cobranca(devedor_id);
comment on table public.bens_cobranca is
  'Bem já constrito/averbado no processo da cobrança (imóvel, veículo, conta, cotas). Pista de patrimônio não entra aqui: fica em investigacao_entidades.';

create table if not exists public.bens_constricoes (
  id uuid primary key default gen_random_uuid(),
  bem_id uuid not null references public.bens_cobranca(id) on delete cascade,
  tipo text not null check (tipo in ('averbacao_premonitoria','penhora','arresto','indisponibilidade','sisbajud','renajud','cnib','outra')),
  -- Número do ato no registro: AV.18, R.20; no Sisbajud, o protocolo.
  ato_registro text,
  data_ato date,
  -- CNJ completo (0003506-49.2022.8.16.0209), nunca abreviado.
  numero_processo text check (numero_processo is null or numero_processo ~ '^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$'),
  mov_folha text,
  valor numeric(14,2),
  depositario text,
  situacao text not null default 'ativa' check (situacao in ('ativa','cancelada','levantada')),
  documento_id uuid references public.documentos(id) on delete set null,
  observacao text,
  criado_por uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_bens_constricoes_bem on public.bens_constricoes(bem_id, data_ato);

drop trigger if exists trg_bens_cobranca_updated_at on public.bens_cobranca;
create trigger trg_bens_cobranca_updated_at before update on public.bens_cobranca
  for each row execute function public.set_updated_at();
drop trigger if exists trg_bens_constricoes_updated_at on public.bens_constricoes;
create trigger trg_bens_constricoes_updated_at before update on public.bens_constricoes
  for each row execute function public.set_updated_at();

alter table public.bens_cobranca enable row level security;
alter table public.bens_constricoes enable row level security;

-- Só o escritório. Proprietário tudo; colaborador só nas cobranças dele (mesmo
-- predicado de cobrancas_colaborador_owned). Cedente e devedor: nada — o papel é
-- testado explicitamente porque o cedente LÊ cobrancas pela própria RLS.
drop policy if exists bens_cobranca_proprietario on public.bens_cobranca;
create policy bens_cobranca_proprietario on public.bens_cobranca for all to authenticated
  using (current_user_papel()='proprietario') with check (current_user_papel()='proprietario');
drop policy if exists bens_cobranca_colaborador on public.bens_cobranca;
create policy bens_cobranca_colaborador on public.bens_cobranca for all to authenticated
  using (current_user_papel()='colaborador' and exists (select 1 from public.cobrancas c where c.id=cobranca_id and (c.cadastrado_por=auth.uid() or c.assigned_to=auth.uid())))
  with check (current_user_papel()='colaborador' and exists (select 1 from public.cobrancas c where c.id=cobranca_id and (c.cadastrado_por=auth.uid() or c.assigned_to=auth.uid())));

drop policy if exists bens_constricoes_proprietario on public.bens_constricoes;
create policy bens_constricoes_proprietario on public.bens_constricoes for all to authenticated
  using (current_user_papel()='proprietario') with check (current_user_papel()='proprietario');
drop policy if exists bens_constricoes_colaborador on public.bens_constricoes;
create policy bens_constricoes_colaborador on public.bens_constricoes for all to authenticated
  using (current_user_papel()='colaborador' and exists (select 1 from public.bens_cobranca b join public.cobrancas c on c.id=b.cobranca_id where b.id=bem_id and (c.cadastrado_por=auth.uid() or c.assigned_to=auth.uid())))
  with check (current_user_papel()='colaborador' and exists (select 1 from public.bens_cobranca b join public.cobrancas c on c.id=b.cobranca_id where b.id=bem_id and (c.cadastrado_por=auth.uid() or c.assigned_to=auth.uid())));

revoke all on public.bens_cobranca, public.bens_constricoes from anon;
grant select, insert, update, delete on public.bens_cobranca, public.bens_constricoes to authenticated;

commit;
