-- 20260703_nf_avulsa.sql — Tabela para NFS-e AVULSAS (emitidas pelo cadastro do
-- tomador, sem vínculo a um pagamento/fin_operacao). Alimenta o menu "Emitir NF"
-- e o handler api/_emitir-nf-avulso.js. Owner-only (mesmo padrão de fin_operacao).

create table if not exists public.nf_avulsa (
  id                uuid primary key default gen_random_uuid(),
  nome              text,
  doc               text,
  doc_digits        text,
  valor             numeric not null,
  descricao         text,
  asaas_customer_id text,
  nf_asaas_id       text,
  nf_url            text,
  nf_status         text not null default 'pendente',  -- pendente|emitindo|emitida|processando|erro
  erro              text,
  metadata          jsonb not null default '{}'::jsonb,
  criada_por        uuid,
  criada_em         timestamptz not null default now()
);

create index if not exists nf_avulsa_doc_digits_idx on public.nf_avulsa (doc_digits);
create index if not exists nf_avulsa_criada_em_idx  on public.nf_avulsa (criada_em desc);
-- Idempotência por ref (uma linha do lote): nota EMITIDA não duplica.
create unique index if not exists nf_avulsa_ref_emitida_uidx
  on public.nf_avulsa ((metadata->>'ref'))
  where nf_status = 'emitida' and (metadata->>'ref') is not null;

alter table public.nf_avulsa enable row level security;
drop policy if exists nf_avulsa_owner_all on public.nf_avulsa;
create policy nf_avulsa_owner_all on public.nf_avulsa
  for all using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');
