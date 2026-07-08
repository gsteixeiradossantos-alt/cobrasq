-- Acesso do CEDENTE em devedores — SELECT only. AMPLIA devedores_cedente_scope/_grupo:
-- além dos devedores cujo cliente_id é do próprio cedente, permite ler qualquer devedor
-- que seja PARTE (principal/avalista/solidário) de uma COBRANÇA do cedente.
-- Corrige coobrigados cujo devedores.cliente_id aponta para outro credor (ex.: Ueslei/Cecato
-- numa cobrança do Bidão): sem isso, o nome do devedor não resolve no join e o caso some do
-- portal. Policies SELECT combinam por OR — aditiva, NÃO toca nas policies existentes.
-- Reusa os helpers current_user_grupo_economico()/current_user_grupo() (20260625).
-- Aplicar em prod via apply_migration (gated).
drop policy if exists devedores_cedente_parte on public.devedores;
create policy devedores_cedente_parte on public.devedores for select to authenticated
  using (
    id in (
      select p.devedor_id
      from public.cobranca_partes p
      join public.cobrancas c on c.id = p.cobranca_id
      where c.cliente_id in (
        select id from public.clientes where app_user_id = auth.uid()
        union
        select id from public.clientes
          where current_user_grupo_economico() is not null
            and grupo_economico_id = current_user_grupo_economico()
        union
        select id from public.clientes
          where current_user_grupo() is not null
            and (cliente_grupo_id = current_user_grupo() or id = current_user_grupo())
      )
    )
  );

-- Índices de apoio à subconsulta da policy (idempotentes; volume por cedente é pequeno).
create index if not exists idx_cobranca_partes_devedor on public.cobranca_partes(devedor_id);
create index if not exists idx_cobranca_partes_cobranca on public.cobranca_partes(cobranca_id);
create index if not exists idx_cobrancas_cliente on public.cobrancas(cliente_id);
