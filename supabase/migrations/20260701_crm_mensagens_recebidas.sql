-- ============================================================
-- WhatsApp inbound — mensagens RECEBIDas dos devedores + fila de pendentes
-- ============================================================
-- Até aqui o sistema era OUTBOUND-only: o zapi-webhook só gravava STATUS de
-- entrega (crm_mensagens_status). Esta migration cria a captura do que o
-- cliente ENVIA, alimentada pela Edge Function `zapi-recebidas` (evento
-- "Ao receber" do Z-API), e uma view que deriva a fila de conversas
-- "sem resposta" cruzando recebidas × status de envio.
--
-- Convenção do projeto: `caso_id` = id em `devedores` (devedores e cobrancas
-- compartilham o mesmo id; `casos` é view). Mesmo padrão de crm_mensagens_status.

CREATE TABLE IF NOT EXISTS public.crm_mensagens_recebidas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   text UNIQUE,                       -- id do Z-API (idempotência)
  telefone     text NOT NULL,                     -- normalizado 55 + DDD + número
  caso_id      uuid REFERENCES public.devedores(id) ON DELETE SET NULL,
  texto        text,
  tipo         text NOT NULL DEFAULT 'texto',     -- texto | imagem | audio | documento
  midia_url    text,
  recebida_em  timestamptz NOT NULL DEFAULT now(),
  raw          jsonb
);

CREATE INDEX IF NOT EXISTS idx_recebidas_tel_data
  ON public.crm_mensagens_recebidas(telefone, recebida_em DESC);
CREATE INDEX IF NOT EXISTS idx_recebidas_caso
  ON public.crm_mensagens_recebidas(caso_id);

ALTER TABLE public.crm_mensagens_recebidas ENABLE ROW LEVEL SECURITY;

-- SELECT/ALL: só staff (proprietario/colaborador), igual a crm_mensagens_status.
-- O INSERT em produção é feito pela Edge Function com SERVICE ROLE (bypassa RLS),
-- então não precisa de policy de INSERT pública. (v2: estreitar colaborador por
-- dono do caso via join em devedores — ver plano.)
DROP POLICY IF EXISTS msg_recebida_staff_all ON public.crm_mensagens_recebidas;
CREATE POLICY msg_recebida_staff_all ON public.crm_mensagens_recebidas
  FOR ALL
  USING (current_user_papel() = ANY(ARRAY['proprietario','colaborador']))
  WITH CHECK (current_user_papel() = ANY(ARRAY['proprietario','colaborador']));

COMMENT ON TABLE public.crm_mensagens_recebidas IS
  'Mensagens recebidas (inbound) do WhatsApp. Gravada pela Edge Function zapi-recebidas (evento "Ao receber" do Z-API). caso_id = devedores.id resolvido por telefone.';

-- ------------------------------------------------------------
-- Resolver o caso (devedor) a partir do telefone recebido.
-- Casa pelos ÚLTIMOS 8 dígitos pra ser robusto ao 9º dígito / DDI.
-- security definer + search_path fixo (evita advisor de search_path mutável).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolver_caso_por_telefone(p_tel text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.devedores
  WHERE length(regexp_replace(coalesce(telefone, ''), '\D', '', 'g')) >= 8
    AND right(regexp_replace(coalesce(telefone, ''), '\D', '', 'g'), 8)
        = right(regexp_replace(coalesce(p_tel, ''), '\D', '', 'g'), 8)
  LIMIT 1;
$$;

-- A função bypassa RLS (definer); só a Edge Function (service role) deve chamá-la,
-- senão um usuário logado poderia mapear telefone -> id de devedor de outro tenant.
REVOKE EXECUTE ON FUNCTION public.resolver_caso_por_telefone(text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolver_caso_por_telefone(text) TO service_role;

-- ------------------------------------------------------------
-- Fila de conversas pendentes: por telefone, a ÚLTIMA mensagem recebida que
-- NÃO teve envio nosso depois dela. (crm_mensagens_status registra todo
-- outbound da instância, com telefone_enviado/evento_em.) Quando o operador
-- responde, a conversa sai da fila sozinha — sem flag manual.
-- security_invoker=true: herda a RLS de crm_mensagens_recebidas (staff-only).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_conversas_pendentes
WITH (security_invoker = true) AS
SELECT r.*
FROM public.crm_mensagens_recebidas r
WHERE r.recebida_em = (
  SELECT max(r2.recebida_em)
  FROM public.crm_mensagens_recebidas r2
  WHERE r2.telefone = r.telefone
)
AND NOT EXISTS (
  SELECT 1
  FROM public.crm_mensagens_status s
  WHERE regexp_replace(coalesce(s.telefone_enviado, ''), '\D', '', 'g')
        = regexp_replace(r.telefone, '\D', '', 'g')
    AND s.evento_em > r.recebida_em
);

COMMENT ON VIEW public.vw_conversas_pendentes IS
  'Conversas de WhatsApp sem resposta: última recebida por telefone sem outbound posterior. Fonte da aba "Pendentes".';
