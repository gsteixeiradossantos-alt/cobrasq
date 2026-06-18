-- 2026-06-18_peticoes_acordo.sql
-- ---------------------------------------------------------------------------
-- Menu de Petições (fase inicial) — 2 modelos voltados a ACORDO:
--   1) Cumprimento de Sentença — Acordo Homologado (art. 523 CPC): intimação para
--      pagamento do valor total em 15 dias sob pena de multa de 10% + honorários 10%.
--   2) Execução de Título Judicial — Descumprimento de Acordo.
--
-- Contexto: a tabela public.peticao_templates já existe e tem 2 constraints CHECK
-- conflitantes no campo `tipo`:
--   - chk_peticao_templates_tipo (nova, ampla): aceita 'execucao_titulo','outro' etc.
--   - peticao_templates_tipo_check (LEGADA, restritiva): só aceita
--     inicial_cobranca|execucao_extrajudicial|monitoria|busca_apreensao|outros
-- A interseção das duas IMPEDE cadastrar os tipos novos. Esta migração remove a
-- constraint LEGADA redundante e amplia a nova para incluir 'cumprimento_sentenca'.
-- As 4 peças já existentes continuam válidas (todas usam tipos aceitos pela nova).
-- ---------------------------------------------------------------------------

begin;

-- 1) Remove a constraint legada redundante.
alter table public.peticao_templates
  drop constraint if exists peticao_templates_tipo_check;

-- 2) Recria a constraint nova incluindo 'cumprimento_sentenca'.
alter table public.peticao_templates
  drop constraint if exists chk_peticao_templates_tipo;
alter table public.peticao_templates
  add constraint chk_peticao_templates_tipo check (tipo = any (array[
    'inicial_cobranca','monitoria','cumprimento_sentenca','execucao_titulo',
    'execucao_extrajudicial','protesto','busca_apreensao','despejo','arrolamento','outro'
  ]));

-- 3) Seed idempotente dos 2 modelos (por `nome`).

-- 3.1) Cumprimento de Sentença — Acordo Homologado
insert into public.peticao_templates (tipo, nome, descricao, ativo, variaveis, conteudo_html)
select
  'cumprimento_sentenca',
  'Cumprimento de Sentença — Acordo Homologado',
  'Requer o cumprimento de sentença e a intimação do executado para pagar o valor total em 15 dias, sob pena de multa de 10% e honorários de 10% (art. 523 CPC). Vinculado ao acordo (parcelas em aberto) e à calculadora.',
  true,
  '[
    {"key":"processo.vara","tipo":"select","label":"Juízo / Vara","opcoes":["Vara Cível","Juizado Especial Cível","1ª Vara Cível","2ª Vara Cível"],"default":"Vara Cível","obrigatorio":true},
    {"key":"processo.comarca","tipo":"select","label":"Comarca","opcoes":["Dois Vizinhos","Chopinzinho","Coronel Vivida","Francisco Beltrão","Laranjeiras do Sul","Marmeleiro","Pato Branco","Salto do Lontra","Santo Antônio do Sudoeste","São João","Outro"],"default":"Dois Vizinhos","obrigatorio":true},
    {"key":"processo.numero","tipo":"text","label":"Número dos autos","obrigatorio":true,"placeholder":"0000000-00.0000.8.16.0000"},
    {"key":"cliente.razao_social","auto":"cliente.razao_social","tipo":"text","label":"Exequente (credor)","obrigatorio":true},
    {"key":"cliente.cnpj","auto":"cliente.cnpj","tipo":"text","label":"CNPJ do exequente"},
    {"key":"devedor.nome","auto":"devedor.nome","tipo":"text","label":"Executado (devedor)","obrigatorio":true},
    {"key":"devedor.doc","auto":"devedor.doc","tipo":"text","label":"CPF/CNPJ do executado","obrigatorio":true},
    {"key":"devedor.endereco","auto":"devedor.endereco","tipo":"textarea","label":"Endereço do executado","obrigatorio":true},
    {"key":"acordo.valor_total_brl","auto":"acordo.valor_total_brl","tipo":"text","label":"Valor total do acordo"},
    {"key":"acordo.num_parcelas","auto":"acordo.num_parcelas","tipo":"text","label":"Parcelas (total)"},
    {"key":"acordo.parcelas_pagas","auto":"acordo.parcelas_pagas","tipo":"text","label":"Parcelas pagas"},
    {"key":"acordo.parcelas_abertas","auto":"acordo.parcelas_abertas","tipo":"text","label":"Parcelas em aberto"},
    {"key":"acordo.saldo_aberto_brl","auto":"acordo.saldo_aberto_brl","tipo":"text","label":"Saldo em aberto (nominal)"},
    {"key":"calculo.total_brl","auto":"calculo.total_brl","tipo":"text","label":"Valor atualizado (cálculo)","obrigatorio":true},
    {"key":"data_peticao","auto":"hoje_extenso","tipo":"text","label":"Data (por extenso)"}
  ]'::jsonb,
  '<p class="enderecamento">Excelentíssimo(a) Senhor(a) Doutor(a) Juiz(a) de Direito da {{processo.vara}} da Comarca de {{processo.comarca}} — Estado do Paraná.</p>
<p class="processo-num">Autos n. {{processo.numero}}</p>
<p class="qualificacao"><strong>{{cliente.razao_social}}</strong>, pessoa jurídica de direito privado inscrita no CNPJ sob o n. {{cliente.cnpj}}, já qualificada nos autos em epígrafe, por seu advogado que esta subscreve, vem, respeitosamente, à presença de Vossa Excelência, com fundamento nos arts. 513 e 523 do Código de Processo Civil, requerer o</p>
<h2 class="secao">Cumprimento de Sentença</h2>
<p>em face de <strong>{{devedor.nome}}</strong>, inscrito(a) no CPF/CNPJ sob o n. {{devedor.doc}}, residente e domiciliado(a) em {{devedor.endereco}}, pelas razões de fato e de direito a seguir expostas.</p>
<p class="subtitulo">I – Do título executivo judicial</p>
<p>As partes celebraram acordo nos presentes autos, devidamente homologado por sentença, por meio do qual a parte executada obrigou-se ao pagamento de {{acordo.valor_total_brl}}, em {{acordo.num_parcelas}} parcelas, constituindo título executivo judicial nos termos do art. 515, II e III, do CPC.</p>
<p class="subtitulo">II – Do descumprimento e do saldo devedor</p>
<p>Das parcelas avençadas, {{acordo.parcelas_pagas}} foram adimplidas, remanescendo {{acordo.parcelas_abertas}} em aberto, o que importa o saldo devedor nominal de {{acordo.saldo_aberto_brl}}. Devidamente atualizado, o débito perfaz o montante de <strong>{{calculo.total_brl}}</strong>, conforme demonstrativo de cálculo anexo.</p>
<p class="subtitulo">III – Dos pedidos</p>
<p class="pedido"><em>a)</em> seja a parte executada intimada, na forma do art. 513, §2º, do CPC, para que, no prazo de <strong>15 (quinze) dias</strong>, efetue o pagamento do valor total de <strong>{{calculo.total_brl}}</strong>, sob pena de acréscimo de <strong>multa de 10% (dez por cento)</strong> e de <strong>honorários advocatícios de 10% (dez por cento)</strong>, nos termos do art. 523, §1º, do CPC;</p>
<p class="pedido"><em>b)</em> não havendo pagamento voluntário no prazo legal, o início imediato dos atos de expropriação, com penhora e avaliação de bens, nos termos do art. 523, §3º, do CPC;</p>
<p class="pedido"><em>c)</em> a condenação da parte executada ao pagamento das custas e despesas processuais.</p>
<p>Termos em que, pede deferimento.</p>
<p class="fecho-data">{{processo.comarca}} – PR, {{data_peticao}}.</p>
<p class="fecho-nome">{{advogado.nome}}</p>
<p class="fecho-oab">OAB/{{advogado.uf_oab}} {{advogado.numero_oab}}</p>'
where not exists (
  select 1 from public.peticao_templates where nome = 'Cumprimento de Sentença — Acordo Homologado'
);

-- 3.2) Execução de Título Judicial — Descumprimento de Acordo
insert into public.peticao_templates (tipo, nome, descricao, ativo, variaveis, conteudo_html)
select
  'execucao_titulo',
  'Execução de Título Judicial — Descumprimento de Acordo',
  'Petição de execução do título executivo judicial (acordo homologado) por descumprimento, cobrando o saldo das parcelas em aberto, atualizado pela calculadora.',
  true,
  '[
    {"key":"processo.vara","tipo":"select","label":"Juízo / Vara","opcoes":["Vara Cível","Juizado Especial Cível","1ª Vara Cível","2ª Vara Cível"],"default":"Vara Cível","obrigatorio":true},
    {"key":"processo.comarca","tipo":"select","label":"Comarca","opcoes":["Dois Vizinhos","Chopinzinho","Coronel Vivida","Francisco Beltrão","Laranjeiras do Sul","Marmeleiro","Pato Branco","Salto do Lontra","Santo Antônio do Sudoeste","São João","Outro"],"default":"Dois Vizinhos","obrigatorio":true},
    {"key":"processo.numero","tipo":"text","label":"Número dos autos de origem","obrigatorio":true,"placeholder":"0000000-00.0000.8.16.0000"},
    {"key":"cliente.razao_social","auto":"cliente.razao_social","tipo":"text","label":"Exequente (credor)","obrigatorio":true},
    {"key":"cliente.cnpj","auto":"cliente.cnpj","tipo":"text","label":"CNPJ do exequente"},
    {"key":"cliente.endereco","auto":"cliente.endereco","tipo":"textarea","label":"Endereço do exequente"},
    {"key":"devedor.nome","auto":"devedor.nome","tipo":"text","label":"Executado (devedor)","obrigatorio":true},
    {"key":"devedor.doc","auto":"devedor.doc","tipo":"text","label":"CPF/CNPJ do executado","obrigatorio":true},
    {"key":"devedor.endereco","auto":"devedor.endereco","tipo":"textarea","label":"Endereço do executado","obrigatorio":true},
    {"key":"acordo.valor_total_brl","auto":"acordo.valor_total_brl","tipo":"text","label":"Valor total do acordo"},
    {"key":"acordo.num_parcelas","auto":"acordo.num_parcelas","tipo":"text","label":"Parcelas (total)"},
    {"key":"acordo.parcelas_pagas","auto":"acordo.parcelas_pagas","tipo":"text","label":"Parcelas pagas"},
    {"key":"acordo.parcelas_abertas","auto":"acordo.parcelas_abertas","tipo":"text","label":"Parcelas em aberto"},
    {"key":"acordo.saldo_aberto_brl","auto":"acordo.saldo_aberto_brl","tipo":"text","label":"Saldo em aberto (nominal)"},
    {"key":"calculo.total_brl","auto":"calculo.total_brl","tipo":"text","label":"Valor executado (atualizado)","obrigatorio":true},
    {"key":"data_peticao","auto":"hoje_extenso","tipo":"text","label":"Data (por extenso)"}
  ]'::jsonb,
  '<p class="enderecamento">Excelentíssimo(a) Senhor(a) Doutor(a) Juiz(a) de Direito da {{processo.vara}} da Comarca de {{processo.comarca}} — Estado do Paraná.</p>
<p class="qualificacao"><strong>{{cliente.razao_social}}</strong>, pessoa jurídica de direito privado inscrita no CNPJ sob o n. {{cliente.cnpj}}, com endereço em {{cliente.endereco}}, vem, respeitosamente, por seu advogado, à presença de Vossa Excelência, com fundamento nos arts. 515, 523 e 824 e seguintes do Código de Processo Civil, propor a presente</p>
<h2 class="secao">Execução de Título Executivo Judicial</h2>
<p>em face de <strong>{{devedor.nome}}</strong>, inscrito(a) no CPF/CNPJ sob o n. {{devedor.doc}}, residente e domiciliado(a) em {{devedor.endereco}}, pelos fatos e fundamentos a seguir.</p>
<p class="subtitulo">I – Do título e do acordo descumprido</p>
<p>As partes firmaram acordo homologado judicialmente nos autos n. {{processo.numero}}, no valor de {{acordo.valor_total_brl}}, em {{acordo.num_parcelas}} parcelas. A parte executada, contudo, descumpriu o avençado: das parcelas, {{acordo.parcelas_pagas}} foram pagas e {{acordo.parcelas_abertas}} permanecem em aberto.</p>
<p class="subtitulo">II – Do valor executado</p>
<p>O saldo em aberto, de natureza líquida, certa e exigível, importa o valor nominal de {{acordo.saldo_aberto_brl}}, que, atualizado, perfaz <strong>{{calculo.total_brl}}</strong>, conforme demonstrativo de cálculo anexo.</p>
<p class="subtitulo">III – Dos pedidos</p>
<p class="pedido"><em>a)</em> a citação da parte executada para, no prazo de 3 (três) dias, efetuar o pagamento do valor executado de <strong>{{calculo.total_brl}}</strong>, sob pena de penhora (art. 829 do CPC);</p>
<p class="pedido"><em>b)</em> não havendo pagamento, a penhora e a avaliação de tantos bens quantos bastem para a satisfação do débito;</p>
<p class="pedido"><em>c)</em> a fixação dos honorários advocatícios, com a redução pela metade em caso de pagamento integral no prazo (art. 827, §1º, do CPC), e a condenação da parte executada nas custas processuais.</p>
<p>Termos em que, pede deferimento.</p>
<p class="fecho-data">{{processo.comarca}} – PR, {{data_peticao}}.</p>
<p class="fecho-nome">{{advogado.nome}}</p>
<p class="fecho-oab">OAB/{{advogado.uf_oab}} {{advogado.numero_oab}}</p>'
where not exists (
  select 1 from public.peticao_templates where nome = 'Execução de Título Judicial — Descumprimento de Acordo'
);

commit;

-- ---------------------------------------------------------------------------
-- ROLLBACK (executar manualmente se necessário):
--   begin;
--   delete from public.peticao_templates
--     where nome in ('Cumprimento de Sentença — Acordo Homologado',
--                    'Execução de Título Judicial — Descumprimento de Acordo');
--   alter table public.peticao_templates drop constraint if exists chk_peticao_templates_tipo;
--   alter table public.peticao_templates add constraint chk_peticao_templates_tipo check (tipo = any (array[
--     'inicial_cobranca','monitoria','execucao_titulo','execucao_extrajudicial',
--     'protesto','busca_apreensao','despejo','arrolamento','outro']));
--   alter table public.peticao_templates add constraint peticao_templates_tipo_check check (tipo = any (array[
--     'inicial_cobranca','execucao_extrajudicial','monitoria','busca_apreensao','outros']));
--   commit;
-- ---------------------------------------------------------------------------
