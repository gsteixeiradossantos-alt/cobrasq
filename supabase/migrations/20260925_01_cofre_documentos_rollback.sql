-- Rollback do cofre de documentos da empresa (20260925_01_cofre_documentos.sql).
-- ATENÇÃO: derruba os metadados. Os objetos do bucket 'cofre' NÃO são apagados
-- aqui de propósito — apagar arquivo é irreversível e fica a cargo do gestor.

drop policy if exists cofre_select on storage.objects;
drop policy if exists cofre_insert on storage.objects;
drop policy if exists cofre_update on storage.objects;
drop policy if exists cofre_delete on storage.objects;

drop policy if exists cofre_arquivos_select on public.cofre_arquivos;
drop policy if exists cofre_arquivos_insert on public.cofre_arquivos;
drop policy if exists cofre_arquivos_update on public.cofre_arquivos;
drop policy if exists cofre_arquivos_delete on public.cofre_arquivos;

drop table if exists public.cofre_arquivos;

-- Bucket fica de pé (pode conter arquivos). Para removê-lo, esvazie antes:
--   delete from storage.buckets where id = 'cofre';
