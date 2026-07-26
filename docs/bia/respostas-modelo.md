# Respostas-modelo — Bia

Textos-base (categoria `resposta_modelo`) para duas situações diferentes:

1. A maioria das entradas aqui é só referência de tom/estrutura pra quando eu
   (Claude Code) ou o Gustavo respondemos manualmente um devedor fora do
   fluxo automático — NÃO são injetadas no prompt da Bia. Adapte ao caso
   real, nunca copie literalmente com os dados de outro devedor.
2. Algumas entradas (marcadas explicitamente) são buscadas por `slug`
   específico pelo CÓDIGO de `bia-atendimento` e enviadas ao cliente
   VERBATIM, sem passar pela IA — usadas quando o texto precisa ser exato
   (ex.: explicação comercial com números/condições reais, onde não dá pra
   arriscar a IA parafrasear errado). Editar o `.md` + rodar o sync já muda
   o que é enviado, sem redeploy.

## Confirmação de alteração de vencimento aplicada
<!-- slug: confirmacao-alteracao-vencimento | categoria: resposta_modelo | ordem: 10 -->

"Oi {nome}! Tudo certo, alterei o vencimento da parcela pro dia {nova_data}.
O valor atualizado ficou em R$ {novo_valor}. Segue o link pra pagamento:
{link}"

Só mandar DEPOIS de o devedor ter confirmado que vai pagar na nova data, e
depois de a alteração já estar feita no Asaas + `bia_cobranca` sincronizada.
Nunca mandar como promessa antes de aplicar de fato.

## Pedido de prazo negado pelo gestor
<!-- slug: pedido-prazo-negado | categoria: resposta_modelo | ordem: 20 -->

"Oi! Sobre a data que você pediu, não consegui liberar dessa vez. Se ajudar,
a gente ajeita dentro deste mês. Qual o melhor dia pra você?"

## Explicação comercial pra lead (enviada VERBATIM, ver nota do topo)
<!-- slug: explicacao-comercial-lead | categoria: resposta_modelo | ordem: 40 -->

Que bom seu interesse! Deixa eu te explicar rapidinho como funciona.

A COBRASQ recupera valores que devedores devem à sua empresa, por acordo extrajudicial. Não tem custo inicial: sem mensalidade, sem taxa de adesão, e se a gente não recuperar, você não paga nada.

O valor principal da dívida volta inteiro pro seu caixa. A COBRASQ fica só com os acessórios: juros, correção e multa que a inadimplência acumulou.

Vou passar seu contato agora pra nossa equipe comercial, pra fazer o diagnóstico gratuito da sua carteira e ver os detalhes com você.

Fonte: conteúdo real de cobrasq-landing/index.html (seções "risco zero" e
"como funciona"), confirmado com o Gustavo em 26/07/2026 como ainda válido.
Se as condições mudarem (preço, garantias, processo), atualizar aqui.

## Devedor em dificuldade financeira
<!-- slug: devedor-dificuldade-financeira | categoria: resposta_modelo | ordem: 30 -->

Demonstrar empatia real primeiro, depois reforçar que o acordo foi firmado e
precisa ser cumprido, explicar as consequências reais (ação judicial,
negativação) SEM tom de ameaça, e oferecer mais prazo como saída concreta.
Nunca oferecer desconto mesmo nesse cenário — ver [[nunca-oferece-desconto]].
