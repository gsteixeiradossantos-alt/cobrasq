-- ============================================================================
-- RLS · colaborador lê o devedor do caso que é dele
--
-- APLICADA EM PRODUÇÃO em 29/07/2026, com autorização do dono.
-- É a peça que faltava para poder ligar o security_invoker na view `casos`
-- (ver 20260729_f04_casos_security_invoker.sql).
--
-- O PROBLEMA. O colaborador enxerga a COBRANÇA quando é dele (cadastrou ou é
-- responsável), mas não necessariamente o DEVEDOR daquela cobrança: dono da
-- cobrança e dono do devedor podem ter se separado numa transferência que só
-- mexeu num dos dois. Enquanto a view `casos` rodava como DEFINER isso ficava
-- invisível — ela ignorava a RLS e abria as duas gavetas. Ao ligar o invoker,
-- esses casos apareceriam sem o nome do devedor.
--
-- A REGRA. Já está implícita no produto: se o caso é meu, o devedor do caso é
-- visível para mim. É o mesmo desenho da policy `devedores_cedente_parte`, que
-- faz exatamente isso para o cedente.
--
-- ESCOPO. SELECT apenas — escrita continua governada por
-- `devedores_colaborador_owned` (ALL, cadastrado_por/assigned_to).
--
-- IMPACTO MEDIDO ANTES DE APLICAR (de 274 devedores no sistema):
--   Natália Pasa Bailke ........ 66 → 68  (+2, exatamente os 2 órfãos)
--   Mikaelly ................... 12 → 12  (+0)
--   Arivieri / GT Conexões ......  0 →  0  (+0)
-- Não é alargamento amplo: é fechar uma lacuna pontual.
--
-- ROLLBACK: drop policy if exists devedores_colaborador_parte on public.devedores;
-- ============================================================================

create policy devedores_colaborador_parte
  on public.devedores
  for select
  to authenticated
  using (
    current_user_papel() = 'colaborador'
    and id in (
      select p.devedor_id
        from public.cobranca_partes p
        join public.cobrancas c on c.id = p.cobranca_id
       where c.cadastrado_por = auth.uid() or c.assigned_to = auth.uid()
    )
  );

-- ── VERIFICAÇÃO ────────────────────────────────────────────────────────────
-- Simulando o JWT do colaborador, dentro de begin/rollback, nenhum caso dele
-- pode ficar sem parte:
--   select count(*), count(*) filter (where jsonb_array_length(partes)=0)
--     from public.casos;
-- Resultado em 29/07 para a Natália: 62 casos, 0 sem devedor.
