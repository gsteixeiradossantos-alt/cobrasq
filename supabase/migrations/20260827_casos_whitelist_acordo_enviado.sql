-- 20260827_casos_whitelist_acordo_enviado
--
-- Status novo "Acordo enviado": aplicado ao caso quando o termo vai para assinatura
-- pelo botão "Enviar pro ZapSign". Duas coisas precisam acompanhar no banco.
--
-- (1) LISTA BRANCA DA VIEW `casos`.
--     A view só inclui a cobrança quando `passo_atual` ou `encerramento` existem, ou
--     quando o status está numa lista branca escrita na própria definição. Medido em
--     27/08/2026: das 656 cobranças ativas, 579 têm passo_atual e encerramento nulos —
--     ou seja, estão na view SÓ pelo status. Sem esta entrada, marcar qualquer uma
--     delas como "Acordo enviado" tira o caso de `casos`, e quem lê `casos`
--     (bia-atendimento, beatriz-msg, peticao-assistente) deixa de encontrá-lo. Na
--     prática: o devedor responde o link de assinatura no WhatsApp e a Bia não acha
--     o caso. Some sem erro e sem aviso — mesmo defeito de
--     20260803_casos_whitelist_etiquetas_novas e 20260826_casos_whitelist_orto_suspensa.
--
-- (2) DERIVAÇÃO DE `etapa` EM cobrancas_set_etapa().
--     O ramo `~* 'acordo'` casaria "Acordo enviado" e gravaria etapa='acordo'. Termo
--     enviado e não assinado não é acordo ativo: não há parcela para acompanhar. Vai
--     para 'negociando', igual ao que o painel deriva em runtime (cobEtapa) — sem
--     isto a coluna e a tela discordam.
--
-- Idempotente nas duas partes. Aborta sem tocar em nada se a âncora esperada sumir.

-- (1) view casos ------------------------------------------------------------
DO $$
DECLARE def text; novo text;
BEGIN
  SELECT pg_get_viewdef('public.casos'::regclass, true) INTO def;
  def := regexp_replace(def, ';\s*$', '');
  IF position('Acordo enviado' in def) = 0 THEN
    novo := replace(
      def,
      '''Orto suspensa''::text]',
      '''Orto suspensa''::text, ''Acordo enviado''::text]'
    );
    IF novo = def THEN
      RAISE EXCEPTION 'ancora ''Orto suspensa'' nao encontrada na viewdef — abortando sem alterar a view';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW public.casos WITH (security_invoker = true) AS ' || novo;
  END IF;
END $$;

-- (2) trigger de etapa ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cobrancas_set_etapa()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.etapa := case
    when coalesce(new.status,'') ~* 'quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebido' then 'encerrado'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null
     and coalesce(new.status,'') ~* 'execu|cumprimento|penhora|hasta|expropria' then 'execucao'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is null
     and coalesce(new.status,'') ~* 'fazer a[çc][ãa]o|para protocolar|reajuizar|a[çc][ãa]o de|monit[óo]ria|locupletamento' then 'fazer_acao'
    when coalesce(new.status,'') ~* 'an[áa]lise' then 'analise'
    -- Termo no ZapSign, ainda sem assinatura: negociação em aberto, não acordo ativo.
    -- Precisa vir ANTES do ramo 'acordo', que casaria por conter a palavra.
    when coalesce(new.status,'') ~* 'acordo +enviado' then 'negociando'
    when coalesce(new.status,'') ~* 'acordo' then 'acordo'
    when nullif(btrim(coalesce(new.numero_processo,'')),'') is not null then 'em_acao'
    when coalesce(new.status,'') ~* 'negocia|proposta|em contato|contatad' then 'negociando'
    when coalesce((select max(e.criado_em) from public.cobranca_partes cp
        join public.devedor_eventos e on e.devedor_id = cp.devedor_id
       where cp.cobranca_id = new.id), new.etapa_atualizada_em, new.updated_at, new.created_at)
       < now() - interval '90 days' then 'travado'
    else 'cobrar' end;
  if tg_op = 'UPDATE' and new.etapa is distinct from old.etapa then
    new.etapa_atualizada_em := now();
  elsif tg_op = 'INSERT' then
    new.etapa_atualizada_em := coalesce(new.etapa_atualizada_em, now());
  end if;
  return new;
end; $function$;
