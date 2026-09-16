# Investigação patrimonial

## O que esta primeira versão faz

O botão **Iniciar Investigação Patrimonial** na ficha do devedor cria uma
investigação em `investigacoes_patrimoniais`, uma entidade-raiz (pessoa ou
empresa) e processa na hora as fontes públicas disponíveis. O
resultado é um grafo auditável de entidades, vínculos, fontes e evidências.
Cada achado deve conter fonte, data da consulta, confiança e uma justificativa.
O relatório baixado pelo CRM consolida essas informações e os fatores do score.

O módulo não tenta contornar CAPTCHA, autenticação, sigilo fiscal/bancário ou
restrição judicial. Conectores judiciais são somente pontos de entrada para
credenciais legitimamente obtidas pelo escritório e para uso autorizado.

## Instalação

1. Revise e aplique manualmente `supabase/migrations/20260916_01_investigacao_patrimonial.sql` no projeto `jokbxzhcctcwnbhkhgru`. Não execute `supabase db push` em lote.
2. Recarregue o painel. Abra uma ficha de devedor: o botão ficará na seção
   **Investigação patrimonial**.
3. Publique a Edge Function `investigacao-patrimonial-worker`. Ela exige a
   sessão autenticada do CRM e confere pela RLS se o usuário pode acessar aquela
   investigação. Não há n8n, cron nem segredo adicional para configurar.
4. Teste primeiro com um cadastro de homologação. Confirme que o registro aparece
   na investigação, que o relatório baixa e que cedente/devedor não têm acesso.

## Credenciais e limites

As credenciais de fontes profissionais ficam exclusivamente na Edge Function
(ou no cofre dela), nunca no
frontend nem em `investigacao_fontes`.

| Variável | Uso | Obrigatória |
| --- | --- | --- |
| `SUPABASE_URL` | URL do projeto Supabase | Sim |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker: grava resultados após validar a sessão | Sim, secreta |
| `CNPJA_TOKEN` | Consulta profissional por sócio, se contratada | Não |
| `PORTAL_TRANSPARENCIA_TOKEN` | API federal, se usada | Não |
| `ESCAVADOR_TOKEN` | API/monitoramento Escavador, se contratado | Não |
| `INFOSIMPLES_TOKEN` | Consultas permitidas pelo contrato | Não |

Antes de habilitar uma fonte profissional, registre o fornecedor, escopo de uso,
custo por chamada e fundamento de acesso. Fontes marcadas como `judicial` ou
`restrita` exigem também autorização explícita do responsável; não devem ser
agendadas por padrão.

## Processamento direto pelo CRM

O botão chama a Edge Function para a investigação que acabou de criar (ou o
botão **Processar agora** para uma pendente), atualiza para `em_andamento`, respeita
`profundidade_maxima` e `entidades_maximas`, e conclui com `concluida`,
`aguardando_acesso` ou `falhou`.

Nesta primeira versão, a pessoa raiz consulta a base pública Receita carregada
no Supabase para encontrar empresas; a empresa raiz consulta a BrasilAPI para
listar o quadro societário. Para cada entidade, o worker faz `upsert` usando a chave única:

`investigacao_id + tipo + chave_normalizada`

Para cada evidência, produza `hash_conteudo` determinístico (por exemplo,
SHA-256 de `fonte + referência externa + URL + trecho normalizado`). Isso evita
duplicidade em reexecuções. Uma pista só sobe para `confirmada` após uma fonte
primária ou validação humana.

Score recomendado, sempre gravado em `score_componentes`:

- crédito ou contrato público potencial: até 30;
- processo em que a pessoa aparece como credora/herdeira: até 25;
- empresa ativa com vínculo confirmado: até 20;
- ativo individual confirmado (imóvel, veículo ou rural): até 20;
- evidência de fonte primária e recente: até 10;
- deduza pontos por homônimo, telefone compartilhado ou fonte não conclusiva.

O total é limitado a 100. Cada componente deve ter `{rotulo, pontos,
explicacao}`; não use o score como afirmação de fraude ou de titularidade.

## Fontes previstas

- Públicas: base CNPJ/RFB carregada (`rf_*`), BrasilAPI por CNPJ, DJEN, DataJud,
  PNCP e portais de transparência.
- Profissionais: CNPJá, Escavador e InfoSimples, somente quando contratados.
- Consulta manual/autorizada: IEPTB/CENPROT (protestos) e RI Digital/ONR
  (certidões imobiliárias). Não são executadas pelo worker e um resultado de
  protesto não equivale a ativo disponível.
- Pontos de entrada: tribunais autenticados, pesquisas de imóveis, veículos e
  rural. Eles recebem resultado somente de acesso que o escritório já possua;
  esta versão não os executa automaticamente.

Na fonte Receita já carregada, reutilize as RPCs `buscar_empresas_por_socio`,
`buscar_empresas_por_telefone`, `buscar_empresas_por_endereco` e
`buscar_empresas_por_email`. Telefone em mais de três CNPJs deve ser marcado
como compartilhado, não como vínculo confirmado.

Antes de `buscar_empresas_por_endereco`, o worker valida o CEP no ViaCEP. Se o
retorno não trouxer logradouro (caso típico de CEP municipal), não chama a RPC
e registra a fonte como não conclusiva; endereço fiscal é sempre **pista**, não
prova de patrimônio ou de grupo econômico.

O resumo também reserva os campos `recebe_ente_publico` e
`cobertura_processual`. O primeiro só pode ser `true` após uma fonte pública
identificar vínculo/pagamento e deve trazer órgão, referência e data; o segundo
deve declarar as UFs/tribunais realmente consultados. Ausência de Escavador ou
de contrato de cobertura nacional é “não conclusivo”, nunca “sem processos”.

## Regras de uso na execução

- DJEN e consultas processuais são radar; crédito, imóvel, veículo ou vínculo
  só vira diligência após confirmação na fonte primária.
- Para PF informal no JEC com radar vazio, o sistema não sugere automaticamente
  SNIPER, CNIB ou Constrijud. A recomendação permanece dependente do histórico
  do caso (por exemplo, reiteração de *Sisbajud* se cabível, mandado ou acordo).
- OSINT fica limitado a busca aberta por nome/cidade e termos de contexto; não
  requer login nem faz coleta pesada de redes sociais.

## Verificação pós-instalação

Como proprietário, crie uma investigação e verifique: uma linha em
`investigacoes_patrimoniais`, entidade-raiz em `investigacao_entidades`, evento
`criada` e nota em `devedor_eventos`. Como colaborador, confirme que vê apenas
casos atribuídos/cadastrados por ele. Como cedente e devedor, confirme que as
tabelas retornam zero linhas.

Depois de aplicar a migração, recarregue o painel para evitar que uma aba antiga
continue usando um estado anterior.
