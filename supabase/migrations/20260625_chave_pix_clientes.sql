-- Adiciona coluna chave_pix na tabela clientes
-- Aplicar em prod: psql ou Supabase dashboard → SQL Editor
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS chave_pix TEXT;
COMMENT ON COLUMN public.clientes.chave_pix IS 'Chave PIX do cliente cedente (CPF, CNPJ, e-mail, telefone ou chave aleatória)';
