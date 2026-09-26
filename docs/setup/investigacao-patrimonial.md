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

## Correções de 26/09/2026

- Migração `20260926_01_investigacao_cobranca_id.sql`: a função de início gravava o
  id do devedor como `cobranca_id`; nos devedores sem cobrança de mesmo id (117 de
  1.119) o botão falhava por chave estrangeira. Agora a cobrança vem de
  `cobranca_partes` (principal primeiro) ou fica nula.
- Worker v3: o repositório estava na v1 (sem CORS) enquanto a produção rodava a
  v2 — republicar do repo quebraria o botão. A v3 parte da v2 e: só marca
  "confirmada" com CPF conferido no QSA ou CPF na razão social (MEI); reserva a
  investigação de forma atômica; retoma `em_andamento` parado há mais de 10 min;
  não duplica o devedor quando ele aparece no QSA; grava a situação cadastral por
  extenso; "fontes concluídas" lista só as que rodaram.
- Painel: relatório escapa HTML dos dados externos e mostra a situação cadastral;
  "Processar agora" também aparece para investigação travada.

## Fontes novas (worker v4, 26/09/2026)

| Fonte | O que faz | Status do que acha |
|---|---|---|
| Base CNPJ por telefone/e-mail (`receita_rf`) | Telefone e e-mail do cadastro do devedor e das empresas **confirmadas** (o cadastro do MEI traz o contato pessoal do titular) → RPCs `buscar_empresas_por_telefone`/`_email` | Sempre **pista**; contato usado por mais de 3 CNPJs é marcado como provável contador |
| Portal da Transparência (`portal_transparencia`) | `/pessoa-fisica` ou `/pessoa-juridica` (vínculos federais: servidor, pensionista, contratado, sanções, benefícios impenhoráveis) e `/contratos/cpf-cnpj` do devedor e das empresas confirmadas | Evidência na própria entidade; só contrato **vigente** conta como recebível |
| PNCP (`pncp`) | Busca textual de contratos pelo nome; o detalhe de cada contrato traz o CPF/CNPJ do fornecedor | Documento igual = recebível (se vigente); só o nome igual = **pista** (homônimo possível); o resto é descartado |
| DJEN via Vigia (`djen`) | Não consulta o DJEN (ele devolve 403 ao Supabase): lê `vigia_acoes` do devedor, exceto os descartados | Entidade `processo`; `cpf_confere=true` confirma, senão **pista**. Polo A = crédito a penhorar no rosto dos autos; polo P = outros credores / rastro de bens |

- Chave do Portal: segredo `PORTAL_TRANSPARENCIA_KEY` no Supabase (nunca no repo).
  Sem a chave, a fonte fica em "não conclusivas".
- Cada fonte isola as próprias falhas: uma que cair (timeout, 403) vai para
  `fontes_nao_conclusivas` e as outras seguem.
- `resumo.recebe_ente_publico`: `true` se há contrato vigente com documento
  conferido ou vínculo de servidor/pensionista federal; `false` se Portal e PNCP
  rodaram sem nada; `null` se não deu para verificar.
- O relatório passou a mostrar o trecho e o link de cada evidência, e tribunal/polo
  dos processos.

## Investigação por cobrança e teia (26/09/2026)

- Menu lateral **Carteira → Investigação patrimonial** (`#/investigacao`): busca a
  cobrança (devedor, credor, CPF/CNPJ ou nº do processo), lista as partes de
  `cobranca_partes` e cria uma investigação por parte marcada. Colaborador também
  usa — a RPC e a RLS já limitam ao que ele enxerga.
- No detalhe da cobrança, a aba **Investigação patrimonial** substituiu a antiga
  "Andamentos / CRM" (que só tinha atalhos). Os botões Atribuir tarefa, Registrar
  negativação e Reatribuir responsável foram para **Resumo → Ações rápidas**, e a
  etapa do funil para a coluna lateral do Resumo.
- Migração `20260926_03_investigacao_cobranca_escolhida.sql`: a RPC ganhou
  `p_cobranca_id` (opcional). Com ele, a investigação fica amarrada à cobrança
  escolhida — e recusa devedor que não é parte dela. Sem ele, vale a regra antiga
  (cobrança principal do devedor). A investigação continua aparecendo na ficha do
  devedor.
- **Teia**: grafo radial em SVG próprio (sem biblioteca) — alvo no centro,
  profundidade 1 e 2 em anéis, cada filho na fatia do círculo do seu "pai". Cor
  por tipo (pessoa, empresa, processo); círculo vazio tracejado = pista não
  confirmada; linha tracejada = vínculo abaixo de 70%. Clicar num nó mostra os
  vínculos e as evidências dele. O PDF traz a mesma teia (PNG) na primeira página.

## Tela no jeito Sniper e relatório em dossiê (26/09/2026)

Inspirado na descrição pública do SNIPER/CNJ (docs.pdpj.jus.br/servicos-negociais/sniper)
e em guias de análise de vínculos CPF/CNPJ. Nada mudou no worker nem no banco: tudo é
leitura do que ele já grava.

- **Tela do resultado**: cartão do investigado com contadores (pode penhorar, empresas
  confirmadas/pistas, pessoas, processos como autor/réu, sinais de alerta) e três abas:
  **Grafo** (com filtro por tipo de entidade, por tipo de vínculo e "só confirmados"),
  **Tabela** (o que pode ser penhorado, empresas, pessoas, processos, contratos e
  vínculos públicos; clicar numa linha abre o nó) e **Sinais de alerta**.
- **Teia**: nós quadrados com ícone (pessoa, empresa, processo); cor da linha por tipo de
  vínculo (sócio, mesmo endereço, mesmo telefone/e-mail, parte em processo); selo verde
  "$" = pode penhorar, laranja "!" = sinal de alerta. Filtrar não move os outros nós.
- **O que pode ser penhorado** (`_invAnalise`): contrato público vigente (PNCP/Portal),
  renda federal de servidor/pensionista, processo em que o devedor é autor (penhora no
  rosto dos autos), quotas de empresa ativa confirmada. Benefício marcado "impenhorável"
  aparece à parte.
- **Sinais de alerta** (sempre pista, nunca acusação): mesma pessoa no quadro de 2+
  empresas da teia; 2+ empresas no endereço fiscal do devedor; empresa do devedor
  baixada/inapta/suspensa/nula; devedor réu em 3+ processos; ressalva quando o contato
  é usado por mais de 3 CNPJs (provável contador).
- **Não implementado**: "sócio em empresas recém-abertas" depende da data de abertura,
  que o worker não grava hoje.
- **PDF em dossiê**: 1. identificação (com credor e processo da cobrança); 2. o que pode
  ser penhorado; 3. teia; 4. achados por categoria; 5. sinais de alerta; 6. fontes que
  responderam e que não responderam; 7. critérios do score; anexos com todas as
  evidências e a linha do tempo.
