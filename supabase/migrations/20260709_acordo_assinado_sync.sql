-- 20260709_acordo_assinado_sync
-- Quando um acordo e assinado no ZapSign (acordos.status_zapsign='assinado'), reflete no CRM:
-- a cobranca vinculada vira passo_atual='Acordo assinado' + fora_crm=true (sai do CRM, segue no
-- Faturamento para acompanhar o pagamento das parcelas). Independente da edge function
-- zapsign-webhook (belt-and-suspenders): o webhook ja fazia isso em refletirAssinaturaNoCRM, mas
-- falhou na entrega para 7 acordos historicos. O trigger garante o sync direto no banco.
-- Vinculo: acordos.cobranca_id costuma ser nulo; usa devedor_id (= cobrancas.id, invariante 1:1).

CREATE OR REPLACE FUNCTION public.fn_acordo_assinado_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cobranca_id uuid := COALESCE(NEW.cobranca_id, NEW.devedor_id);
  v_data text := COALESCE(NEW.data_assinatura::text, now()::text);
BEGIN
  IF NEW.status_zapsign IS DISTINCT FROM 'assinado' THEN
    RETURN NEW;
  END IF;
  IF v_cobranca_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.cobrancas c
     SET passo_atual = 'Acordo assinado',
         fora_crm    = true,
         acordo_final = jsonb_set(COALESCE(c.acordo_final, '{}'::jsonb), '{assinado}', 'true'::jsonb)
                        || jsonb_build_object('data_assinatura', v_data),
         updated_at  = now()
   WHERE c.id = v_cobranca_id
     AND c.encerramento IS NULL
     AND (COALESCE(c.passo_atual,'') IS DISTINCT FROM 'Acordo assinado'
          OR COALESCE(c.fora_crm,false) = false);

  RETURN NEW;
END;
$$;

-- Trigger function nao precisa ser chamavel via API (PostgREST).
REVOKE EXECUTE ON FUNCTION public.fn_acordo_assinado_sync() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_acordo_assinado_sync ON public.acordos;
CREATE TRIGGER trg_acordo_assinado_sync
  AFTER INSERT OR UPDATE OF status_zapsign, data_assinatura
  ON public.acordos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_acordo_assinado_sync();

-- Backfill dos acordos ja assinados que ainda nao refletiam no CRM (rodado em 2026-07-09):
-- UPDATE public.cobrancas c SET passo_atual='Acordo assinado', fora_crm=true,
--   acordo_final = jsonb_set(COALESCE(c.acordo_final,'{}'::jsonb),'{assinado}','true'::jsonb)
--                  || jsonb_build_object('data_assinatura', (SELECT max(a.data_assinatura)::text
--                       FROM acordos a WHERE a.cobranca_id=c.id OR a.devedor_id=c.id)),
--   updated_at=now()
-- FROM acordos a
-- WHERE (c.id=a.cobranca_id OR c.id=a.devedor_id) AND a.data_assinatura IS NOT NULL
--   AND c.encerramento IS NULL AND COALESCE(c.fora_crm,false)=false;
