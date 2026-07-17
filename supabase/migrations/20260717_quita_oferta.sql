-- ============================================================================
-- ⛔ ESQUELETO — ONDA 2 (QuitaFácil). **NÃO APLICADA EM PRODUÇÃO.**
-- Revisar antes de aplicar manualmente no SQL Editor do Supabase. Não rodar db push cego.
-- ============================================================================
-- QuitaFácil — oferta de autonegociação do portal do devedor.
--
-- Espelha o modelo de segurança do portal_meu_caso (20260706): o devedor é ANON,
-- então a elegibilidade e a política (desconto/parcelas por credor, que vivem em
-- clientes.metadata->'quita' e NÃO são legíveis por anon) são resolvidas SERVER-SIDE
-- a partir do TOKEN DE SESSÃO (prova de posse). Nunca aceita devedor_id/cobranca_id
-- cru do cliente — resolve tudo a partir da sessão.
--
-- Retorno:
--   { ok, elegivel, cobranca_id, valor_atual, capital,
--     desc_avista, max_parcelas, parcela_min }
--
-- A oferta é a FONTE AUTORITATIVA: a edge function quita-fechar DEVE reconferir
-- por aqui antes de gerar boleto/acordo (não confiar em valores vindos do front).
--
-- ROLLBACK: drop function public.quita_oferta(text);
-- ============================================================================

create or replace function public.quita_oferta(p_sessao_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_devedor_id uuid;
  v_cob        record;
  v_cfg        jsonb;
  v_ativo      boolean;
  v_limite     numeric;
  v_desc       numeric;
  v_maxp       int;
  v_parcmin    numeric;
  v_capital    numeric;
  v_elegivel   boolean;
begin
  -- Prova de posse (idêntico ao portal_meu_caso).
  if p_sessao_token is null or length(p_sessao_token) < 20 then
    return jsonb_build_object('ok', false, 'erro', 'Sessão inválida.');
  end if;

  select devedor_id into v_devedor_id
  from public.portal_sessoes
  where token = p_sessao_token and expira_em > now()
  limit 1;

  if v_devedor_id is null then
    return jsonb_build_object('ok', false, 'erro', 'Sessão expirada.');
  end if;

  -- Mesma dívida que o portal_meu_caso mostra (principal, não-arquivada, recente).
  select c.id, c.cliente_id, c.valor_atual, c.valor_orig, c.valor_capital,
         c.fase, c.numero_processo, c.status, c.divida
    into v_cob
  from public.cobranca_partes cp
  join public.cobrancas c on c.id = cp.cobranca_id
  where cp.devedor_id = v_devedor_id
    and coalesce(c.arquivado, false) = false
  order by coalesce(cp.principal, false) desc, c.created_at desc nulls last
  limit 1;

  if v_cob.id is null then
    return jsonb_build_object('ok', true, 'elegivel', false, 'erro', 'Sem dívida ativa.');
  end if;

  -- Política do credor (clientes.metadata->'quita') com defaults globais.
  select coalesce(cl.metadata->'quita', '{}'::jsonb) into v_cfg
  from public.clientes cl where cl.id = v_cob.cliente_id;
  v_cfg := coalesce(v_cfg, '{}'::jsonb);

  -- ativo = visibilidade/enquadramento (default on). disparoAtivo = EXPOR NO PORTAL
  -- (boleto real) — OPT-IN por credor (default OFF), a trava do piloto.
  v_ativo   := coalesce((v_cfg->>'ativo')::boolean, true)
               and coalesce((v_cfg->>'disparoAtivo')::boolean, false);
  v_limite  := coalesce(nullif(v_cfg->>'limite','')::numeric, 500);
  v_desc    := coalesce(nullif(v_cfg->>'descAvista','')::numeric, 10);
  v_maxp    := coalesce(nullif(v_cfg->>'maxParcelas','')::int, 12);
  v_parcmin := coalesce(nullif(v_cfg->>'parcelaMin','')::numeric, 150);

  -- Capital: coluna dedicada → divida.valorCapital → valor_orig → valor_atual.
  v_capital := coalesce(
    v_cob.valor_capital,
    nullif(v_cob.divida->>'valorCapital','')::numeric,
    v_cob.valor_orig,
    v_cob.valor_atual
  );

  -- Elegibilidade (espelha cobElegivelQuita do front): extrajudicial, sem processo,
  -- não acordo/encerrada, credor ativo, capital>0 e ≤ limite.
  v_elegivel :=
        coalesce(v_cob.fase, 'extrajudicial') = 'extrajudicial'
    and coalesce(trim(v_cob.numero_processo), '') = ''
    and coalesce(v_cob.status, '') !~* '(acord|quitad|encerrad|baixad|devolvid|sem ?[êe]xito|recebid)'
    and v_ativo
    and coalesce(v_capital, 0) > 0
    and coalesce(v_capital, 0) <= v_limite;

  return jsonb_build_object(
    'ok', true,
    'elegivel', v_elegivel,
    'devedor_id', v_devedor_id,   -- o próprio devedor da sessão (usado pelo quita-fechar)
    'cobranca_id', v_cob.id,
    'valor_atual', v_cob.valor_atual,
    'capital', v_capital,
    'desc_avista', v_desc,
    'max_parcelas', v_maxp,
    'parcela_min', v_parcmin
  );
end;
$function$;

revoke all on function public.quita_oferta(text) from public;
grant execute on function public.quita_oferta(text) to anon, authenticated;
