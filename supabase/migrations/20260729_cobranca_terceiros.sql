-- Terceiros interessados na cobrança (cônjuge/companheiro do executado, coproprietário).
--
-- POR QUE UMA TABELA PRÓPRIA, E NÃO UM PAPEL EM cobranca_partes:
-- todos os papéis de cobranca_partes (emitente, endossante, avalista, fiador,
-- devedor_solidario, sucessor) significam "responde pela dívida", e a tabela é lida por
-- fluxos que DISPARAM cobrança: régua de WhatsApp (api/cron-regua.js), QuitaFácil,
-- negativação no Serasa, portal do devedor (RPC portal_meu_caso / quita_oferta) e a view
-- `casos` que alimenta a Bia. Além disso cobranca_partes.devedor_id é FK obrigatória para
-- `devedores`, e é `devedores` que casa por telefone/CPF nesses fluxos.
-- Cadastrar ali um terceiro que NÃO deve nada abriria caminho para cobrar, negativar e dar
-- acesso ao portal a quem não é devedor. Esta tabela é ignorada por todos esses consumidores
-- por construção: o terceiro só aparece onde for explicitamente buscado.
--
-- Uso típico: penhora que recai sobre bem comum do casal, em que o cônjuge ou companheiro
-- do executado deve ser intimado (arts. 842 e 843 do CPC) para resguardo da meação, sem que
-- se lhe impute responsabilidade pela dívida.

create table if not exists public.cobranca_terceiros (
  id            uuid primary key default gen_random_uuid(),
  cobranca_id   uuid not null references public.cobrancas(id) on delete cascade,
  nome          text not null,
  doc           text,
  rg            text,
  qualidade     text not null default 'conjuge'
                check (qualidade in ('conjuge','companheiro','coproprietario','condomino','credor_hipotecario','outro')),
  endereco      text,
  telefone      text,
  intimado      boolean not null default false,
  intimado_em   date,
  observacao    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.cobranca_terceiros is
  'Terceiros interessados na cobrança (art. 842/843 CPC). NÃO são devedores: nunca devem entrar em régua de cobrança, negativação ou portal do devedor.';
comment on column public.cobranca_terceiros.intimado is
  'Marca se o terceiro já foi intimado da constrição.';

create index if not exists idx_cobranca_terceiros_cobranca on public.cobranca_terceiros(cobranca_id);
create index if not exists idx_cobranca_terceiros_doc on public.cobranca_terceiros((regexp_replace(coalesce(doc,''), '\D', '', 'g')));

-- RLS: espelha exatamente o padrão de cobranca_partes (proprietário, colaborador dono,
-- cedente por app_user_id e cedente por grupo econômico).
alter table public.cobranca_terceiros enable row level security;

drop policy if exists cobranca_terceiros_proprietario_all on public.cobranca_terceiros;
create policy cobranca_terceiros_proprietario_all on public.cobranca_terceiros
  for all
  using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');

drop policy if exists cobranca_terceiros_colaborador_owned on public.cobranca_terceiros;
create policy cobranca_terceiros_colaborador_owned on public.cobranca_terceiros
  for all
  using (
    current_user_papel() = 'colaborador'
    and cobranca_id in (
      select id from public.cobrancas
      where cadastrado_por = auth.uid() or assigned_to = auth.uid()
    )
  )
  with check (
    current_user_papel() = 'colaborador'
    and cobranca_id in (
      select id from public.cobrancas
      where cadastrado_por = auth.uid() or assigned_to = auth.uid()
    )
  );

drop policy if exists cobranca_terceiros_cedente_scope on public.cobranca_terceiros;
create policy cobranca_terceiros_cedente_scope on public.cobranca_terceiros
  for select to authenticated
  using (
    cobranca_id in (
      select c.id from public.cobrancas c
      where c.cliente_id in (select id from public.clientes where app_user_id = auth.uid())
    )
  );

drop policy if exists cobranca_terceiros_cedente_grupo on public.cobranca_terceiros;
create policy cobranca_terceiros_cedente_grupo on public.cobranca_terceiros
  for select to authenticated
  using (
    cobranca_id in (
      select c.id from public.cobrancas c where
        (current_user_grupo_economico() is not null and c.cliente_id in (
           select id from public.clientes where grupo_economico_id = current_user_grupo_economico()))
        or (current_user_grupo() is not null and c.cliente_id in (
           select id from public.clientes where cliente_grupo_id = current_user_grupo() or id = current_user_grupo()))
    )
  );
