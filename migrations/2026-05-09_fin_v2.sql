-- ============================================================
-- Fase A: bank_balance + tipos novos + logo_key + flag saldo geral
-- Aplicado em produção: 2026-05-09 via Supabase MCP
-- Migration: fin_v2_bank_balance_logo_judicial
-- ============================================================

alter table fin_conta
  add column if not exists bank_balance numeric(14,2),
  add column if not exists bank_balance_at timestamptz,
  add column if not exists incluir_no_saldo_geral boolean default true,
  add column if not exists logo_key text;

-- Tipos: 0=Corrente 1=Poupança 2=Investimento 3=Caixa 4=Outros 5=Judicial

-- RPC: saldo geral bancário
create or replace function fin_saldo_geral_bancario()
returns numeric language sql stable security invoker as $$
  select coalesce(sum(bank_balance), 0)
  from fin_conta
  where ativa = true and incluir_no_saldo_geral = true;
$$;
