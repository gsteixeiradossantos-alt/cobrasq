-- Trava de concorrência da régua da Bia (bia-cobranca).
--
-- Sintoma (25/08/2026, 13h40): Matheus, Marcielle e Valery receberam o MESMO
-- lembrete três vezes, no mesmo segundo. Causa: a edge function lê as cobranças
-- com `proximo_lembrete_em <= now()`, envia o WhatsApp (~26s) e só DEPOIS grava
-- o novo `proximo_lembrete_em`. O cron dispara de 2 em 2 minutos e não espera a
-- run anterior; quando a função demora (ou trava e represa invocações, como no
-- 503/546 das 16h28), várias runs leem a MESMA linha ainda vencida e todas
-- enviam. O dedup que existe no worker (`telefonesProcessados`) só vale DENTRO
-- de uma run e não enxerga as concorrentes.
--
-- Correção: reservar a linha ANTES de enviar, num único UPDATE condicional.
-- Só quem recebe a linha de volta envia; as demais runs voltam vazias.

CREATE OR REPLACE FUNCTION public.bia_claim_cobrancas(
  p_limite      integer DEFAULT 20,
  p_lease_secs  integer DEFAULT 300,
  p_telefone    text    DEFAULT NULL
)
RETURNS SETOF public.bia_cobranca
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidatas AS (
    SELECT asaas_payment_id
      FROM public.bia_cobranca
     WHERE status IN ('ativa', 'adiada')
       AND telefone IS NOT NULL
       AND proximo_lembrete_em <= now()
       AND (p_telefone IS NULL OR telefone LIKE '%' || right(p_telefone, 8))
     ORDER BY proximo_lembrete_em ASC
     LIMIT p_limite
     -- pula linhas que outra run já está reservando neste instante
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.bia_cobranca c
     -- lease curto: se o envio falhar no meio, a linha volta a ficar elegível
     -- em p_lease_secs em vez de ficar presa. O worker regrava a data definitiva
     -- (cadência normal ou follow-up) logo após o envio.
     SET proximo_lembrete_em = now() + make_interval(secs => p_lease_secs),
         updated_at          = now()
    FROM candidatas
   WHERE c.asaas_payment_id = candidatas.asaas_payment_id
     -- revalida sob o lock: se outra run reservou entre o SELECT e o UPDATE,
     -- a condição falha e esta run não leva a linha.
     AND c.proximo_lembrete_em <= now()
  RETURNING c.*;
$$;

COMMENT ON FUNCTION public.bia_claim_cobrancas(integer, integer, text) IS
  'Reserva atomicamente as cobranças vencidas da régua da Bia. Chamada pela edge function bia-cobranca ANTES de enviar, para que runs concorrentes do cron não mandem a mesma mensagem duas vezes.';

REVOKE ALL ON FUNCTION public.bia_claim_cobrancas(integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bia_claim_cobrancas(integer, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.bia_claim_cobrancas(integer, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bia_claim_cobrancas(integer, integer, text) TO service_role;
