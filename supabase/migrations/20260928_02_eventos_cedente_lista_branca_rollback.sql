-- Volta eventos_cedente_read ao que era antes de 20260928_02 (sem filtro de tipo).
DROP POLICY IF EXISTS eventos_cedente_read ON public.devedor_eventos;
CREATE POLICY eventos_cedente_read ON public.devedor_eventos
  FOR SELECT TO authenticated
  USING (devedor_id IN (
    SELECT d.id FROM public.devedores d
      JOIN public.clientes c ON c.id = d.cliente_id
     WHERE c.app_user_id = auth.uid()));
