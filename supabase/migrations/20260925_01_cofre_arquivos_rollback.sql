-- Rollback do cofre de arquivos. NÃO apaga os objetos do bucket: só remove
-- as regras e a tabela de metadados. Apagar arquivo é decisão do gestor.
drop policy if exists cofre_storage_select on storage.objects;
drop policy if exists cofre_storage_insert on storage.objects;
drop policy if exists cofre_storage_update on storage.objects;
drop policy if exists cofre_storage_delete on storage.objects;

drop policy if exists cofre_arquivos_select on public.cofre_arquivos;
drop policy if exists cofre_arquivos_insert on public.cofre_arquivos;
drop policy if exists cofre_arquivos_update on public.cofre_arquivos;
drop policy if exists cofre_arquivos_delete on public.cofre_arquivos;

drop table if exists public.cofre_arquivos;
-- Bucket fica: delete from storage.buckets where id='cofre'; -- só se estiver vazio.
