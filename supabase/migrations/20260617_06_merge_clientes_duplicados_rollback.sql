-- 20260617_06_merge_clientes_duplicados_rollback.sql
-- ----------------------------------------------------------------------------
-- Reverte 20260617_06. ATENÇÃO: rode o rollback do 07 (DROP INDEX) ANTES deste —
-- senão o re-INSERT do perdedor (mesmo CNPJ ativo do vencedor) viola a trava.
-- Restaura o relacional de forma exata (linha do perdedor + repoint dos ids
-- capturados no snapshot pré-mescla 2026-06-17). O blob é reconstruído best-effort
-- (relacional é a fonte da verdade; loadRelationalData sobrescreve o blob no load).
-- ----------------------------------------------------------------------------

BEGIN;

-- 1) Recria o cliente perdedor (precisa existir antes de repontar os filhos)
INSERT INTO public.clientes (id, nome, doc, telefone, nome_fantasia, metadata,
                             is_draft, arquivado, eh_matriz, created_at, updated_at)
VALUES ('0e148b44-541d-45e0-8b3c-03183405df3f','Cecato Clinica Veterinaria Ltda',
        '39.513.779/0001-84','46999289933','S O S Animal',
        '{"obs":"","endereco":"Mario de Barros, 331, Sala 02 - Centro Sul, Dois Vizinhos - PR - CEP 85660-000","honorarios":"","loginEmail":"","loginSenha":""}'::jsonb,
        false,false,false,'2026-06-10T16:20:01.897211+00:00','2026-06-10T16:20:01.897211+00:00')
ON CONFLICT (id) DO NOTHING;

-- 2) Repointa de volta os filhos exatos do perdedor (ids do snapshot)
UPDATE public.devedores SET cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f'
WHERE id IN ('2fd88525-b1da-4b8d-9e69-5ab0dcfebbfa','733999f6-5438-4ba8-a0d9-423c60574490',
             '86971e36-3f7b-4230-a55a-3bc4fb53bad1','b69b1a99-30d0-45b7-ab55-08fd2dca2123',
             'f3bdcc38-91fa-4da2-907d-1179eb934ff6');
UPDATE public.cobrancas SET cliente_id='0e148b44-541d-45e0-8b3c-03183405df3f'
WHERE id IN ('2fd88525-b1da-4b8d-9e69-5ab0dcfebbfa','733999f6-5438-4ba8-a0d9-423c60574490',
             '80a33505-79f0-4a79-a872-80ea9038aef0','86971e36-3f7b-4230-a55a-3bc4fb53bad1',
             'a1d9c4d9-fa79-4c56-a477-ef8110245980','b69b1a99-30d0-45b7-ab55-08fd2dca2123',
             'f3bdcc38-91fa-4da2-907d-1179eb934ff6');

-- 3) COBRASQ: desarquiva o extra
UPDATE public.clientes
SET arquivado=false, arquivado_em=null, arquivado_motivo=null
WHERE id='07e5b946-6719-4221-8b0a-b2382b5256a1';

-- 4) BLOB: repoint dos 5 devedores de volta + re-adiciona o cliente perdedor (reconstruído)
UPDATE public.cobrasq_data
SET data = jsonb_set(
  jsonb_set(
    data, '{devedores}',
    (SELECT jsonb_agg(
       CASE WHEN e.val->>'id' IN ('2fd88525-b1da-4b8d-9e69-5ab0dcfebbfa','733999f6-5438-4ba8-a0d9-423c60574490',
                                  '86971e36-3f7b-4230-a55a-3bc4fb53bad1','b69b1a99-30d0-45b7-ab55-08fd2dca2123',
                                  'f3bdcc38-91fa-4da2-907d-1179eb934ff6')
            THEN e.val || jsonb_build_object('clienteId','0e148b44-541d-45e0-8b3c-03183405df3f')
            ELSE e.val END ORDER BY e.ord)
     FROM jsonb_array_elements(data->'devedores') WITH ORDINALITY AS e(val,ord))
  ),
  '{clientes}',
  (data->'clientes') || jsonb_build_array(jsonb_build_object(
     'id','0e148b44-541d-45e0-8b3c-03183405df3f','nome','Cecato Clinica Veterinaria Ltda',
     'doc','39.513.779/0001-84','nomeFantasia','S O S Animal','tel','46999289933','arquivado',false))
),
updated_at=now()
WHERE key='main' AND NOT (data->'clientes' @> '[{"id":"0e148b44-541d-45e0-8b3c-03183405df3f"}]'::jsonb);

COMMIT;
