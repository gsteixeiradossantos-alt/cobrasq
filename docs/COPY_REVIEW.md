# Copy Review — Scripts do CRM (item #14)

**Status:** PROPOSTA. Não implementado no código. Aguarda aprovação do Dr. Gustavo antes de aplicar em `obterMensagens` no `index.html`.

**Princípios** (do spec `docs/specs/crm.md` #14):
- Curto (target <80 palavras por bloco)
- Cirúrgico (sem rodeios)
- Gatilhado (cada parágrafo tem propósito)
- Humano (parecer conversa, não IA)
- Sem mencionar "taxa de serviço" (custo COBRASQ, não cobrado do devedor)

---

## `enviar-1` — Script D — 1ª abordagem (curiosidade)

**Atual** (15 palavras): já curto, OK.
> Boa tarde, [Nome]! Tudo bem? Você teria um minutinho? Preciso falar contigo.

**Proposta:** manter.

---

## `explicar-contexto` — Script K — Apresentação da dívida

**Atual:** 4 blocos, ~150 palavras totais.

**Proposta — versão consolidada** (~70 palavras):
- Bloco 1: `[Nome], aqui é [OPERADORA] da COBRASQ.`
- Bloco 2: `Estou cuidando de uma pendência sua com [credor], no valor atualizado de [valorAvista].`
- Bloco 3: `Resolver direto comigo é a melhor opção — tenho condições que não existem na via judicial. Posso te apresentar?`
- Bloco 4 (REMOVER): "trabalhoso pra todo mundo" é genérico, peso emocional desnecessário.

**Razão:** elimina redundância "amigavelmente / não chegarmos a um consenso / única alternativa", transmite a mesma mensagem em metade.

---

## `sem-resposta-1` — Script E — 2ª tentativa

**Atual** (~50 palavras):
> Oi [Nome], tudo bem? Aqui é da COBRASQ de novo. Vi que minha mensagem anterior passou despercebida. Tenho um assunto importante pra resolver com você, e prefiro fazer isso direto, sem complicar. Me retorna quando puder, mesmo que seja só pra dizer que não tem como conversar agora.

**Proposta** (~35 palavras):
> Oi [Nome], aqui é da COBRASQ. Minha mensagem anterior passou despercebida — tenho um assunto importante. Me responde quando puder, mesmo que seja pra dizer que não dá agora.

**Razão:** "sem complicar / fazer direto" é jargão de cobrador. Remoção endurece o tom corretamente.

---

## `sem-resposta-2` — Script F — 3ª tentativa (última)

**Atual:** 2 blocos, ~110 palavras.

**Proposta** (1 bloco, ~75 palavras):
> [Nome], aqui é da COBRASQ — esta é minha última tentativa de resolver de forma amigável a pendência com [credor], no valor atualizado de [valorAvista].
>
> Sem retorno em 2 dias úteis, o caso vai pra cobrança judicial: custas, juros maiores, oficial de justiça. Valor cresce muito.
>
> Ainda dá pra fechar: PIX por [valorAvista], boleto em [boleto12], ou cartão em [cartao12]. É só responder.

**Razão:** une os dois blocos, corta "ainda dá tempo de resolver direto comigo" (redundante com "ainda dá pra fechar").

---

## `devedor-respondeu` — Script B — 3 formas de pagamento

**Atual** (~60 palavras): já dentro do alvo. OK.

**Proposta:** manter, mas trocar "Quanto antes paga, menos paga no total" por algo mais natural:
> Quanto antes a gente fechar, menos vai aumentar.

**Razão:** "Quanto antes paga, menos paga" parece slogan; "antes a gente fechar" é mais conversacional.

---

## `tergiversou` — Script G — Reagendar

**Atual** (~30 palavras): OK.

**Proposta:** manter.

---

## `sem-dinheiro` — Script A — Persuasão

**Atual:** 4 blocos, ~150 palavras.

**Proposta — consolidar em 2 blocos** (~85 palavras):
- Bloco 1: `Entendo, [Nome]. Não é fácil — por isso quero achar uma saída que caiba no seu momento. Posso parcelar de várias formas. Quanto, mais ou menos, dá pra pagar por mês?`
- Bloco 2: `Qualquer coisa entre R$ 250 e R$ 500 abre opções. Boleto ou cartão em até 12x. Sem fechar agora, o caso vai pra cobrança judicial e o valor cresce — prefiro resolver com você.`

**Razão:** corta repetição "vantagem é que você ainda tem flexibilidade / posso parcelar de várias formas / proposta sob medida".

---

## `pediu-fora-padrao` — Script H — Bloco 1

**Atual** (~25 palavras): OK.

---

## `nao-pago-rebatida` (NOVO no item #1)

Já implementado, ~80 palavras. **OK como está.**

## `nao-pago-escalar-gestor` / `nao-pago-capital-direto` (NOVOS item #1)

Já implementados curtos. **OK.**

---

## `autorizado` / `negado` — Script H Bloco 2

**Atual:** ambos curtos. OK.

---

## `contesta` — Script C

**Atual:** 2 blocos, ~80 palavras. OK.

**Proposta:** trocar "encaminho pra análise e te retorno em até 2 dias úteis" por "te retorno em até 2 dias úteis com a posição" (já é o que tá no bloco 2 — Bloco 1 e 2 são repetitivos).

---

## `ameaca` — Script I

**Atual** (~25 palavras): OK.

---

## `recusa` — Script J — Encaminhamento ao judicial

**Atual:** 4 blocos, ~150 palavras.

**Proposta — 2 blocos** (~85 palavras):
- Bloco 1: `[Nome], agradeço sua atenção. Como não chegamos a acordo amigável, o caso será encaminhado pra fase judicial. As condições conversadas aqui deixam de valer e passam os encargos previstos em lei e contrato.`
- Bloco 2: `Na prática: juros legais de mora, correção, multas, custas, honorários, possível bloqueio de conta/bens. Se reconsiderar antes do protocolo, dá pra fechar nas condições atuais — me responde em 24h. Depois disso, é com o jurídico.`

**Razão:** corta o bloco 4 "ainda dá tempo / aguardo retorno" (redundante com "antes do protocolo, me responde").

---

## `reabriu` — Devedor voltou

**Atual** (~40 palavras): OK.

---

## `finalizar-judicial` / `sem-retorno-final` / `prova-procede` / `prova-improcede`

**Atual:** todos curtos ou só alerta interno. OK.

---

## `reclama-juros-parc` (item #8)

Já curto, ~50 palavras. **OK.**

---

## `reclama-servico` — Script L

**Atual** (~50 palavras): OK.

## `reclamacao-procede` — Script L2

**Atual:** 3 blocos, ~140 palavras.

**Proposta** — manter mas tirar do bloco 3 a frase "Continua valendo a pena fechar nas condições atuais" (redundante após bloco 2 que já fala disso).

---

## `aceitou-avista` / `aceitou-boleto` / `aceitou-cartao`

**Atual:** todos curtos. OK.

---

## Mensagem 1ª pessoal (`gerarPrimeiraMensagem`)

**Atual:** "Boa tarde, [Nome]! Tudo bem? Você teria um minutinho? Preciso falar contigo."

**Considerar:** assinatura do operador agora prepende `*Nome:*\\n\\n` (item #16), então mensagem efetiva fica:
> *Andreia:*
>
> Boa tarde, [Nome]! Tudo bem?...

A 1ª mensagem é deliberadamente vaga (curiosidade). **Manter.**

---

## Próximos passos

1. Gustavo revisa cada bloco e marca quais aprovar / ajustar.
2. Após aprovação, abrir PR aplicando as mudanças no `obterMensagens` em `index.html`.
3. Verificar se nenhum script ainda menciona "taxa de serviço" — uma busca por "taxa" no código mostra que aparece só em (a) cálculo da dívida na criação do caso (`calcMulta` etc.) e (b) `nao-pago-juros` antigo (já substituído pelos 3 novos no item #1). Limpar referência residual no Bloco 2 do script removido.

---

_Gerado em 2026-05-10 como entregável do item #14 (review proposta, não implementação direta)._
