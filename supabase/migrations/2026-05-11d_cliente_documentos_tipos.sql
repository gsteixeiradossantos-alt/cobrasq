-- Etapa 4: enum de tipos pra cliente_documentos + índice
-- Aplicada em produção via MCP em 2026-05-11.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cliente_documentos_tipo') THEN
    ALTER TABLE public.cliente_documentos
      ADD CONSTRAINT chk_cliente_documentos_tipo CHECK (
        tipo IN (
          'contrato_social','procuracao','rg_socio','cpf_socio','cnh_socio',
          'comprovante_endereco','cartao_cnpj','inscricao_estadual',
          'alvara','ata_assembleia','outros'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cliente_documentos_cliente_tipo
  ON public.cliente_documentos(cliente_id, tipo) WHERE ativo;

COMMENT ON COLUMN public.cliente_documentos.tipo IS 'Categoria do documento. CHECK garante valores válidos.';
