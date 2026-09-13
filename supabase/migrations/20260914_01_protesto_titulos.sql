-- ============================================================================
-- 20260914_01 — protesto_titulos: títulos apresentados a protesto pela CRA
-- ----------------------------------------------------------------------------
-- Integração com a API CENPROT Empresas (IEPTB, manual v2.2 de 04/06/2024), via
-- api/_protesto.js (ação `protesto` de api/automacao.js). Uma linha por título
-- enviado; a consulta à CRA atualiza status, protocolo do cartório, custas e o
-- histórico de ocorrências (jsonb). Escrita só pelo backend (service role);
-- staff lê; proprietário pode corrigir pela tela.
-- Status possíveis (manual p. 15): INEXISTENTE, COLETADO, GERADO, AGENDADO, ENVIADO
-- (integrador) e CONFIRMADO, DEVOLVIDO, CANCELADO, PAGO, PROTESTADO, RETIRADO,
-- SUSTADO, SUSPENSO (CRA); mais ERRO e REMOVIDO (locais).
-- Aditiva; rollback pareado. NÃO rodar `supabase db push` cego.
-- ============================================================================

begin;

CREATE TABLE IF NOT EXISTS public.protesto_titulos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  caso_id            text,                     -- devedores.id / cobrancas.id (1:1), texto como no blob
  ambiente           text NOT NULL DEFAULT 'hml' CHECK (ambiente IN ('hml','prod')),
  devedor_nome       text NOT NULL,
  devedor_doc        text NOT NULL,            -- só dígitos
  credor_nome        text NOT NULL,
  credor_doc         text NOT NULL,
  especie            text NOT NULL,            -- sigla CENPROT (DMI, NP, CH, SJ, TA…)
  numero             text NOT NULL,
  nosso_numero       text NOT NULL,
  valor              numeric(14,2) NOT NULL,
  emissao            text NOT NULL,            -- DD/MM/AAAA (formato da CRA; chave da consulta)
  vencimento         text NOT NULL,            -- DD/MM/AAAA ou 99/99/9999 (à vista)
  status             text NOT NULL DEFAULT 'ENVIADO',
  resposta_codigo    text,
  resposta_msg       text,
  xml_envio_ok       boolean,
  enviado_por        text,
  protocolo_cartorio text,
  data_protocolo     text,
  comarca            text,
  cartorio           text,
  custas             jsonb,
  ocorrencias        jsonb,
  ultima_ocorrencia  text,
  consultado_em      timestamptz,
  operacao_pedida    text CHECK (operacao_pedida IS NULL OR operacao_pedida IN ('REMOCAO','DESISTENCIA','CANCELAMENTO')),
  operacao_msg       text,
  operacao_em        timestamptz,
  operacao_por       text
);

CREATE INDEX IF NOT EXISTS protesto_titulos_caso_idx ON public.protesto_titulos (caso_id);
CREATE INDEX IF NOT EXISTS protesto_titulos_devedor_idx ON public.protesto_titulos (devedor_doc);
CREATE UNIQUE INDEX IF NOT EXISTS protesto_titulos_chave_uidx
  ON public.protesto_titulos (ambiente, devedor_doc, nosso_numero, vencimento);

ALTER TABLE public.protesto_titulos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS protesto_staff_select ON public.protesto_titulos;
CREATE POLICY protesto_staff_select ON public.protesto_titulos
  FOR SELECT USING (public.current_user_papel() = ANY(ARRAY['proprietario','colaborador']));
DROP POLICY IF EXISTS protesto_owner_write ON public.protesto_titulos;
CREATE POLICY protesto_owner_write ON public.protesto_titulos
  FOR ALL USING (public.current_user_papel() = 'proprietario')
          WITH CHECK (public.current_user_papel() = 'proprietario');

COMMENT ON TABLE public.protesto_titulos IS
  'Títulos apresentados a protesto pela CRA/CENPROT (api/_protesto.js). Inserts e updates vêm do backend (service role); consulta à CRA atualiza status/custas/ocorrencias.';

commit;
