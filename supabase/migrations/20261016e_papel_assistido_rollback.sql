-- Rollback de 20261016e_papel_assistido.sql. Falha (com razão) se ainda houver linhas
-- com papel = 'assistido': converta/remova essas partes antes.
ALTER TABLE public.cobranca_partes DROP CONSTRAINT IF EXISTS cobranca_partes_papel_check;
ALTER TABLE public.cobranca_partes ADD CONSTRAINT cobranca_partes_papel_check
  CHECK (papel IN ('emitente','endossante','avalista','fiador','devedor_solidario','sucessor'));
