-- Desfaz 20261005_02: tira o link_decisao dos itens do DJEN (fonte='djen').
UPDATE public.devedor_eventos SET payload = payload - 'link_decisao'
 WHERE payload->>'fonte' = 'djen' AND payload ? 'link_decisao';
