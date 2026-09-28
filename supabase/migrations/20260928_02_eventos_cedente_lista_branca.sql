-- Portal do cedente: o cliente só lê do histórico o que é para ele (28/09/2026).
--
-- Antes: eventos_cedente_read liberava ao cedente TODO devedor_eventos dos devedores
-- dele, sem filtro de tipo — notas internas da equipe, mudança de status de
-- migração, scripts. O PR #849 filtrou na tela (cpEventosCliente, index.html);
-- esta política aplica a mesma lista branca no banco, para a leitura direta pela API.
--
-- Regra (aprovada pelo Gustavo em 28/09/2026):
--   * tipos liberados: andamento_judicial, asaas_pagamento_recebido,
--     asaas_pagamento_atrasado, asaas_boletos_emitidos, zapsign_assinado,
--     acordo_assinado_confirmado, acordo_concluido_auto, acordo_cancelado,
--     acordo_descumprido, caso_criado, repasse;
--   * notas (nota_manual, nota, anotacao, historico_legacy, mudanca_status) só com
--     payload.visivel_cliente = true (caixa "Mostrar esta nota ao cliente no portal");
--   * dono: evento com cobranca_id → a cobrança é de um cliente do cedente
--     (inclui caso cujo devedor principal está cadastrado em outro credor);
--     evento sem cobranca_id → o devedor é de um cliente do cedente (regra antiga).
-- Mesma chave de posse da política antiga (clientes.app_user_id = auth.uid()).

DROP POLICY IF EXISTS eventos_cedente_read ON public.devedor_eventos;

CREATE POLICY eventos_cedente_read ON public.devedor_eventos
  FOR SELECT TO authenticated
  USING (
    (
      tipo IN ('andamento_judicial','asaas_pagamento_recebido','asaas_pagamento_atrasado',
               'asaas_boletos_emitidos','zapsign_assinado','acordo_assinado_confirmado',
               'acordo_concluido_auto','acordo_cancelado','acordo_descumprido',
               'caso_criado','repasse')
      OR (
        tipo IN ('nota_manual','nota','anotacao','historico_legacy','mudanca_status')
        AND (payload->>'visivel_cliente' = 'true' OR payload->>'visivelCliente' = 'true')
      )
    )
    AND (
      (cobranca_id IS NOT NULL AND cobranca_id IN (
        SELECT cb.id FROM public.cobrancas cb
          JOIN public.clientes c ON c.id = cb.cliente_id
         WHERE c.app_user_id = auth.uid()))
      OR
      (cobranca_id IS NULL AND devedor_id IN (
        SELECT d.id FROM public.devedores d
          JOIN public.clientes c ON c.id = d.cliente_id
         WHERE c.app_user_id = auth.uid()))
    )
  );
