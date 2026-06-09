-- Migration: SEC-N1 — RLS estrita em proc_intimacoes
-- Substitui as policies abertas criadas em 20260510_06_intimacoes.sql
-- (que permitiam SELECT/INSERT/UPDATE a qualquer auth.uid() IS NOT NULL).
--
-- Modelo:
--   - Staff (proprietario / colaborador) tem acesso total.
--   - Cedente vê intimações de devedores que pertencem a clientes dele.
--   - Devedor não tem acesso (decidir caso S13 evolua para portal devedor).
--
-- Depende de: docs/supabase-security.sql (current_user_papel, clientes, devedores).

DROP POLICY IF EXISTS "intimacoes_select"          ON public.proc_intimacoes;
DROP POLICY IF EXISTS "intimacoes_insert"          ON public.proc_intimacoes;
DROP POLICY IF EXISTS "intimacoes_update"          ON public.proc_intimacoes;
DROP POLICY IF EXISTS "intimacoes_staff_all"       ON public.proc_intimacoes;
DROP POLICY IF EXISTS "intimacoes_cedente_select"  ON public.proc_intimacoes;

-- Staff (proprietario, colaborador): acesso total
CREATE POLICY "intimacoes_staff_all" ON public.proc_intimacoes
  FOR ALL TO authenticated
  USING (public.current_user_papel() IN ('proprietario','colaborador'))
  WITH CHECK (public.current_user_papel() IN ('proprietario','colaborador'));

-- Cedente: lê apenas intimações cujo devedor é de um cliente dele
CREATE POLICY "intimacoes_cedente_select" ON public.proc_intimacoes
  FOR SELECT TO authenticated
  USING (
    devedor_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.devedores d
      JOIN public.clientes c ON c.id = d.cliente_id
      WHERE d.id = proc_intimacoes.devedor_id
        AND c.app_user_id = auth.uid()
    )
  );
