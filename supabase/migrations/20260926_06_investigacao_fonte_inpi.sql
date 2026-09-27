-- Fonte INPI (marcas e patentes) para a investigação patrimonial (worker v8).
-- investigacao_evidencias.fonte_codigo tem FK para investigacao_fontes: sem esta
-- linha a gravação da evidência do INPI falha. Idempotente.
insert into public.investigacao_fontes (codigo, nome, categoria, exige_credencial, exige_autorizacao, ativa, url_documentacao, observacao)
values ('inpi', 'INPI (marcas e patentes)', 'publica', false, false, true, 'https://busca.inpi.gov.br/pePI/',
        'Busca pública pePI. Marca registrada é bem penhorável (CPC art. 835, XIII); conferir titularidade no processo do INPI.')
on conflict (codigo) do nothing;
