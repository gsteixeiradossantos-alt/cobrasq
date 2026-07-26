# Respostas-modelo — Bia

Textos-base (categoria `resposta_modelo`) para quando eu (Claude Code) ou o
Gustavo respondem manualmente um devedor fora do fluxo automático da Bia —
por exemplo, destravando uma conversa parada ou aplicando uma alteração que o
bot não conseguiu concluir sozinho. NÃO são injetados no prompt da Bia (ela já
é instruída a nunca copiar exemplos ao pé da letra) — são só referência de
tom e estrutura. Adapte ao caso real, nunca copie literalmente com os dados
de outro devedor.

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

## Devedor em dificuldade financeira
<!-- slug: devedor-dificuldade-financeira | categoria: resposta_modelo | ordem: 30 -->

Demonstrar empatia real primeiro, depois reforçar que o acordo foi firmado e
precisa ser cumprido, explicar as consequências reais (ação judicial,
negativação) SEM tom de ameaça, e oferecer mais prazo como saída concreta.
Nunca oferecer desconto mesmo nesse cenário — ver [[nunca-oferece-desconto]].
