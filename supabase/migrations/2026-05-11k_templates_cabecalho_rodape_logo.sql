-- Etapa 14: editor fullscreen + cabeçalho/rodapé/logo editáveis no template
-- Aplicada em produção via MCP em 2026-05-11.

ALTER TABLE public.peticao_templates
  ADD COLUMN IF NOT EXISTS cabecalho_html text,
  ADD COLUMN IF NOT EXISTS rodape_html text,
  ADD COLUMN IF NOT EXISTS logo_storage_path text;

COMMENT ON COLUMN public.peticao_templates.cabecalho_html IS 'HTML do cabeçalho da petição. Se null, usa fallback hardcoded "TEIXEIRA Advogados".';
COMMENT ON COLUMN public.peticao_templates.rodape_html IS 'HTML do rodapé. Se null, usa fallback hardcoded.';
COMMENT ON COLUMN public.peticao_templates.logo_storage_path IS 'Path no bucket peticao-assets/logos/. Renderizado dentro do cabeçalho.';
