-- Desfaz 20260926_06: só apaga a fonte se nenhuma evidência a usa.
delete from public.investigacao_fontes f
 where f.codigo = 'inpi'
   and not exists (select 1 from public.investigacao_evidencias e where e.fonte_codigo = 'inpi');
