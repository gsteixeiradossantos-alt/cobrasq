# Erros conhecidos / runbook — Bia

Bugs não-óbvios já diagnosticados e protocolos operacionais (categoria
`erro_conhecido`). Referência para investigar problema parecido de novo —
não injetado no prompt da Bia.

## Bia não responde mesmo com humano_ate limpo (gate duplo)
<!-- slug: gate-duplo-estado-humano-ate | categoria: erro_conhecido | ordem: 10 -->

`bia-atendimento/index.ts` pula a conversa se `whatsapp_atendimentos.estado
=== 'aguardando_humano'`, ANTES de checar `humano_ate`. Limpar só
`humano_ate` não é suficiente — se o `estado` ficou em `aguardando_humano`
(de um handoff antigo), a Bia continua ignorando o telefone mesmo com
`humano_ate` nulo.

Fix: sempre rodar os dois campos juntos.
```sql
UPDATE whatsapp_atendimentos
SET humano_ate = NULL, estado = 'bot', updated_at = now()
WHERE telefone = '...';
```

## enviar-whatsapp não registra em whatsapp_bia_enviadas
<!-- slug: enviar-whatsapp-nao-registra | categoria: erro_conhecido | ordem: 20 -->

A function `enviar-whatsapp` (usada pelo painel/CRM pra envio manual) não
grava em `whatsapp_bia_enviadas`. Se essa function for usada pra mandar algo
que deveria contar como mensagem "da Bia" (ex.: um operador aplicando uma
alteração em nome da Bia), o `zapi-recebidas` recebe o eco `fromMe`, não acha
o `message_id` na tabela, e trata como se um humano tivesse assumido a
conversa — seta `humano_ate` sem querer. Rastreado na issue
[gsteixeiradossantos-alt/cobrasq#416](https://github.com/gsteixeiradossantos-alt/cobrasq/issues/416).
Enquanto não corrigido: depois de usar `enviar-whatsapp` pra falar por conta
da Bia com um devedor, cheque se `humano_ate` foi setado e limpe manualmente
se for o caso (junto com `estado`, ver entrada acima).

## Alteração manual de boleto fora do fluxo bia_aprovacoes
<!-- slug: protocolo-alteracao-manual-boleto | categoria: erro_conhecido | ordem: 30 -->

Quando o fluxo automático (`bia-atendimento` -> `bia_aprovacoes` ->
`bia-cobranca`) não resolve sozinho e a alteração de vencimento precisa ser
feita manualmente (ex.: conversa travada, aprovação antiga com estado
zerado), seguir o MESMO protocolo que o código automatizado aplica em
`bia-cobranca/index.ts` (`alterarVenc`, por volta da linha 118):

1. Confirmar com o devedor que ele vai pagar na nova data.
2. `PUT` no Asaas (`/v3/payments/{id}`) com `dueDate` novo, `value` = valor
   original × 1.11 (arredondado a 2 casas), `fine.value = 0`, e
   `description` explicando a alteração (data antiga -> nova, multa
   retirada, motivo).
3. Sincronizar `bia_cobranca` (`valor`, `venc_atual`) com o que foi
   alterado no Asaas — nunca deixar dessincronizado, ver
   [[glossario-bia-cobranca]] em glossario.md.
4. Mandar a confirmação ao devedor só depois dos passos acima já aplicados
   (nunca prometer antes de executar).
