-- Migration: S8 — endereço separado em campos
-- Spec: docs/specs/site-app.md item S8
-- Aplica em devedores e clientes. Mantém coluna `endereco` por 1 release como fallback.

ALTER TABLE public.devedores
  ADD COLUMN IF NOT EXISTS cep TEXT,
  ADD COLUMN IF NOT EXISTS rua TEXT,
  ADD COLUMN IF NOT EXISTS numero TEXT,
  ADD COLUMN IF NOT EXISTS complemento TEXT,
  ADD COLUMN IF NOT EXISTS bairro TEXT,
  ADD COLUMN IF NOT EXISTS cidade TEXT,
  ADD COLUMN IF NOT EXISTS uf TEXT;

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS cep TEXT,
  ADD COLUMN IF NOT EXISTS rua TEXT,
  ADD COLUMN IF NOT EXISTS numero TEXT,
  ADD COLUMN IF NOT EXISTS complemento TEXT,
  ADD COLUMN IF NOT EXISTS bairro TEXT,
  ADD COLUMN IF NOT EXISTS cidade TEXT,
  ADD COLUMN IF NOT EXISTS uf TEXT;

-- Adicionar nome_fantasia em clientes (S7 — IA cartão CNPJ)
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS nome_fantasia TEXT;
