-- Portal do cedente por GRUPO ECONÔMICO: histórico e intimações (01/10/2026).
--
-- Defeito (simulação de RLS, 01/10/2026): o cedente que acessa por grupo
-- (app_users.grupo_economico_id ou cliente_grupo_id, pode_ver_grupo = true, ref_id
-- vazio — ex.: Arte Estofados, Grupo TIC TAC) via as cobranças e clientes do grupo
-- pelas policies *_cedente_grupo, mas lia 0 linhas de devedor_eventos e de
-- proc_intimacoes: eventos_cedente_read e intimacoes_cedente_select só reconhecem
-- clientes.app_user_id = auth.uid(). Não é regressão (já era assim antes de
-- 20260928_02).
--
-- Correção: duas policies NOVAS, no mesmo padrão das *_cedente_grupo já existentes
-- (clientes, cobrancas, devedores, cobranca_partes, repasses_cliente, documentos).
-- As policies do cedente direto não mudam. Policies permissivas somam por OR.
--   * eventos_cedente_grupo  — mesma lista branca de tipos de 20260928_02.
--   * intimacoes_cedente_grupo — mesma chave da intimacoes_cedente_select
--     (devedores.cliente_id), trocando app_user_id pelo grupo.

DROP POLICY IF EXISTS eventos_cedente_grupo ON public.devedor_eventos;

CREATE POLICY eventos_cedente_grupo ON public.devedor_eventos
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
         WHERE (public.current_user_grupo_economico() IS NOT NULL
                AND c.grupo_economico_id = public.current_user_grupo_economico())
            OR (public.current_user_grupo() IS NOT NULL
                AND (c.cliente_grupo_id = public.current_user_grupo()
                     OR c.id = public.current_user_grupo()))))
      OR
      (cobranca_id IS NULL AND devedor_id IN (
        SELECT d.id FROM public.devedores d
          JOIN public.clientes c ON c.id = d.cliente_id
         WHERE (public.current_user_grupo_economico() IS NOT NULL
                AND c.grupo_economico_id = public.current_user_grupo_economico())
            OR (public.current_user_grupo() IS NOT NULL
                AND (c.cliente_grupo_id = public.current_user_grupo()
                     OR c.id = public.current_user_grupo()))))
    )
  );

DROP POLICY IF EXISTS intimacoes_cedente_grupo ON public.proc_intimacoes;

CREATE POLICY intimacoes_cedente_grupo ON public.proc_intimacoes
  FOR SELECT TO authenticated
  USING (
    devedor_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.devedores d
        JOIN public.clientes c ON c.id = d.cliente_id
       WHERE d.id = proc_intimacoes.devedor_id
         AND ((public.current_user_grupo_economico() IS NOT NULL
               AND c.grupo_economico_id = public.current_user_grupo_economico())
           OR (public.current_user_grupo() IS NOT NULL
               AND (c.cliente_grupo_id = public.current_user_grupo()
                    OR c.id = public.current_user_grupo()))))
  );
