# Glossário — Bia

Termos e tabelas do sistema (categoria `glossario`). Referência para quem for
mexer no código ou investigar um problema — não injetado no prompt da Bia.

## estado (whatsapp_atendimentos)
<!-- slug: glossario-estado | categoria: glossario | ordem: 10 -->

Campo em `whatsapp_atendimentos`: `'bot'` (Bia atende normalmente),
`'aguardando_humano'` (Bia não responde — só um humano tira desse estado),
`'resolvido'` (conversa encerrada; volta a abrir sozinha se o cliente
escrever de novo). `bia-atendimento` pula a conversa se `estado ===
'aguardando_humano'`, **antes** de checar `humano_ate` — ver
[[gate-duplo-estado-humano-ate]] em erros-conhecidos.md.

## humano_ate (whatsapp_atendimentos)
<!-- slug: glossario-humano-ate | categoria: glossario | ordem: 20 -->

Timestamp até quando a Bia fica pausada num telefone (um humano respondeu
recentemente, pelo painel ou pelo próprio celular). Expira sozinho quando o
tempo passa. Não basta limpar isso pra liberar a Bia — ver `estado` acima.

## lote_id (whatsapp_bia_enviadas)
<!-- slug: glossario-lote-id | categoria: glossario | ordem: 30 -->

Agrupa os blocos de uma mesma resposta da Bia enviados em sequência (ela
quebra respostas longas em várias mensagens curtas, como um humano digitando).
Usado pelo trigger de rate-limit pra distinguir "blocos da mesma resposta"
(permitido) de "respostas diferentes em rajada" (bloqueado).

## bia_cobranca
<!-- slug: glossario-bia-cobranca | categoria: glossario | ordem: 40 -->

Espelho das cobranças ativas vindas do Asaas (1 linha por boleto,
`asaas_payment_id` como PK). É o que a Bia lê pra saber o que cobrar — NÃO lê
o Asaas diretamente na conversa. Toda alteração de valor/vencimento no Asaas
precisa ser espelhada aqui, senão a Bia fala com dado desatualizado.
Populada/sincronizada por `bia-cobranca-sync`.

## bia_aprovacoes
<!-- slug: glossario-bia-aprovacoes | categoria: glossario | ordem: 50 -->

Fila de pedidos de alteração de vencimento que o devedor confirmou pra Bia.
Fica `pendente` até o gestor aprovar/negar (pelo WhatsApp admin ou painel).
`bia-cobranca` roda o executor de aprovações a cada 5 min e aplica no Asaas +
avisa o devedor.

## whatsapp_bia_enviadas
<!-- slug: glossario-whatsapp-bia-enviadas | categoria: glossario | ordem: 60 -->

Registra cada mensagem que a própria Bia mandou (`message_id` como PK). Se um
envio NÃO aparece aqui, `zapi-recebidas` trata o eco `fromMe` como se um
humano tivesse mandado, e seta `humano_ate` — pausando a Bia sem querer. Ver
[[enviar-whatsapp-nao-registra]] em erros-conhecidos.md.

## teste_telefone / cobranca_teste_telefone (whatsapp_bia_config)
<!-- slug: glossario-teste-telefone | categoria: glossario | ordem: 70 -->

Quando setado, `bia-atendimento` (`teste_telefone`) ou `bia-cobranca`
(`cobranca_teste_telefone`) age SOMENTE nesse número, ignorando todo o resto
da fila — modo seguro pra testar mudança de comportamento sem afetar
devedores reais.
