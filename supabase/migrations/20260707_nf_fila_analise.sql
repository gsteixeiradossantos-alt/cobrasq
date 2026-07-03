-- 20260707_nf_fila_analise.sql — Fila "aguardando análise" da tela Emitir NF v2.
-- Todo pagamento RECEBIDO/CONFIRMADO no Asaas entra aqui como 'pendente' (via
-- supabase/functions/asaas-webhook). NADA é emitido automaticamente: o usuário
-- decide, item a item ou em lote, Emitir NF (api/_emitir-nf-avulso.js, que grava
-- nf_avulsa e vincula em nf_avulsa_id) ou Dispensar (registra quem/quando).
-- Dedup natural: asaas_payment_id UNIQUE — reenvio de webhook não duplica.
-- Owner-only, mesmo padrão de nf_avulsa/fin_operacao (a tela Emitir NF é
-- exclusiva do proprietário e a emissão é gated no endpoint).

create table if not exists public.nf_fila_analise (
  id               uuid primary key default gen_random_uuid(),
  asaas_payment_id text not null unique,
  customer_id      text,                 -- customer do Asaas (payment.customer)
  nome             text,                 -- preenchido pelo webhook (devedor casado) ou lazy via Asaas
  cpf_cnpj         text,
  valor            numeric not null default 0,
  origem           text not null default 'OUTRO' check (origem in ('PIX','BOLETO','CARTAO','OUTRO')),
  recebido_em      timestamptz not null default now(),
  status           text not null default 'pendente' check (status in ('pendente','emitida','dispensada')),
  decidido_em      timestamptz,
  decidido_por     uuid,
  nf_avulsa_id     uuid references public.nf_avulsa(id) on delete set null,
  endereco_ok      boolean,              -- null = ainda não verificado no Asaas (lazy)
  created_at       timestamptz not null default now()
);

create index if not exists nf_fila_analise_pendente_idx
  on public.nf_fila_analise (recebido_em desc) where status = 'pendente';
create index if not exists nf_fila_analise_customer_idx
  on public.nf_fila_analise (customer_id);

alter table public.nf_fila_analise enable row level security;
drop policy if exists nf_fila_analise_owner_all on public.nf_fila_analise;
create policy nf_fila_analise_owner_all on public.nf_fila_analise
  for all using (current_user_papel() = 'proprietario')
  with check (current_user_papel() = 'proprietario');
