# NFS-e ESNFS — Emissão em lote (COBRASQ)

Extensão do Chrome que emite NFS-e no ESNFS (`esnfs.com.br`) a partir de uma lista
colada de tomadores, seguindo o playbook **“Emitir NFS-e ESNFS (COBRASQ)”**.

Você digita **CPF e valor** de cada tomador, clica em **Iniciar emissão** e
acompanha o lote por um painel que fica no canto da própria página do ESNFS.
O nome vem do próprio ESNFS, que já pesquisa o cadastro pelo CPF.

---

## Versão

A versão aparece em **três lugares**, para você conferir num relance se o Chrome
pegou mesmo a build nova depois do ↻:

- no card da extensão em `chrome://extensions`;
- na etiqueta cinza no canto superior direito do **popup**;
- na etiqueta cinza no cabeçalho do **painel** que roda na página do ESNFS.

Se depois de recarregar o número continuar o antigo, o Chrome não pegou a
alteração — confira se a pasta escolhida em *Carregar sem compactação* é a
mesma que foi atualizada.

| Versão | O que mudou |
|---|---|
| **1.2.0** · 13/09/2026 | Passou a morar no repositório `cobrasq` (`extensao/esnfs/`). Ponte com o painel: a linha colada aceita uma **ref** no fim (`Nome \| CPF \| valor \| fila:…`), que volta no relatório dentro do bloco `COBRASQ-RESULTADO` — é o que o painel lê em *Emitir NF → Importar resultado do ESNFS*. |
| **1.1.0** · 31/07/2026 | Tela clara; formulário com uma caixa por dado; por linha só CPF e valor (o nome vem do ESNFS); endereço padrão passou a “Endereço desconhecido / 0 / Endereço desconhecido / 85660000 / Dois Vizinhos-PR”; versão visível no popup e no painel. |
| 1.0.0 · 31/07/2026 | Primeira versão: lista colada em texto, tema escuro. |

## Integração com o painel COBRASQ

O painel (`painel.cobrasq.com.br` → **Emitir NF**) é quem sabe a base fiscal de cada
recebimento — quando há capital do credor, a nota é só sobre o honorário. Por isso o
lote nasce lá, não aqui:

1. No painel, marque os recebimentos e clique em **Copiar lote p/ ESNFS**. Vai para a
   área de transferência um texto `Nome | CPF | valor | ref`, uma linha por nota.
2. Aqui, cole no campo **CPF** da primeira linha: as linhas se espalham sozinhas. A
   `ref` não aparece, mas fica guardada na linha.
3. Rode o lote. No fim, o relatório copiado traz um bloco
   `--- COBRASQ-RESULTADO v1 ---` com `ref;status;nota;cpf;valor;nome;obs`.
4. No painel, **Importar resultado do ESNFS** → cole o relatório inteiro. Cada nota
   emitida some da fila e entra em *Notas emitidas* e no *Faturamento* do Financeiro
   com o número da prefeitura. As que falharam continuam pendentes.

Nada disso exige login ou token: é tudo pela área de transferência.

## Instalação

1. Abra `chrome://extensions`.
2. Ligue o **Modo do desenvolvedor** (canto superior direito).
3. **Carregar sem compactação** → escolha esta pasta (`extensao/esnfs` do repositório `cobrasq`).
4. Fixe o ícone da extensão na barra (opcional, facilita).

Não há build, npm, nem dependência externa — são cinco arquivos soltos.

## Uso

1. Abra o ESNFS **e faça login** (a extensão usa a sessão que já está no navegador;
   ela não guarda nem digita senha nenhuma).
2. Clique no ícone da extensão.
3. Preencha uma linha por NF — só **CPF/CNPJ** e **Valor**:

   | # | CPF / CNPJ | Valor (R$) | |
   |---|---|---|---|
   | 1 | `108.891.119-60` | `541,00` | ⌄ ✕ |
   | 2 | `134.053.789-31` | `338,00` | ⌄ ✕ |

   - O CPF ganha máscara sozinho; o valor aceita `541,00`, `1.234,56`,
     `R$ 440,72` ou `440.72`.
   - **Enter** no fim da linha cria a próxima. **+ Adicionar tomador** também.
   - **⌄** abre os dados extras da linha (nome, telefone, e-mail, endereço).
     Só preencha se o ESNFS **não** encontrar o cadastro daquele CPF.
   - **Colar** várias linhas de uma planilha no campo de CPF vira várias linhas
     do formulário (aceita `CPF | Valor`, `Nome | CPF | Valor` e, vindo do painel,
     `Nome | CPF | Valor | ref`).

4. CPF inválido ou valor ilegível ficam em vermelho e **bloqueiam** o início.
   O rodapé mostra quantas NFs e o total.
5. **Iniciar emissão**. A aba do ESNFS vai para a tela de emissão e o painel
   aparece no canto inferior direito, com progresso, log e os botões
   Pausar / Retomar / Parar.

Ao terminar, o relatório em Markdown é copiado sozinho para a área de
transferência (e pode ser recopiado pelo botão **Copiar relatório**).

### Modos

| Opção | O que faz |
|---|---|
| Confirmação antes da 1ª NF *(padrão)* | Preenche a primeira nota inteira, mostra na tela e **espera seu OK** antes de gravar. Da segunda em diante, autônomo. |
| Confirmação antes de cada NF | Pede OK em todas. Para lotes delicados. |
| Simulação | Preenche a 1ª nota e **para sem gravar**. Serve para conferir alíquota, discriminação e endereço antes de valer. |

---

## O que a extensão faz por NF

Exatamente a sequência do playbook, com as três armadilhas conhecidas tratadas:

1. Digita o CPF/CNPJ no campo **Cpf/Cnpj** e aguarda o AJAX do cadastro.
2. Abre o cadastro pelo **ícone de lápis** — nunca pelo campo “Pesquisa”, que
   retorna “não encontrado” mesmo para cadastro existente.
3. Aplica as regras de decisão (abaixo) e clica em **Fechar**.
4. **Incluir serviço** → escolhe `17.22.01.000 — Cobrança em geral` → **espera**
   → valor → alíquota → discriminação → **Salvar**.
   A espera é obrigatória: o ESNFS **zera a alíquota** ao selecionar o serviço.
5. Confere que o serviço entrou (total da nota ≠ 0,00) e clica em **Gravar**.
6. Lê a mensagem do ESNFS, registra o número da nota e recarrega a tela limpa
   para a próxima. Nunca reaproveita um formulário sujo.

### Regras de decisão sobre o cadastro do tomador

| Situação do cadastro | O que acontece |
|---|---|
| Completo (endereço, número, bairro, CEP, cidade) | Mantém tudo. Só acrescenta telefone/e-mail se estiverem **vazios**. |
| Sem endereço — **o caso mais comum** | Preenche **apenas os campos que faltam** com o endereço padrão. |
| Vazio | Usa o nome que você digitou na linha e o endereço padrão inteiro. |
| Você preencheu o endereço na linha | O da linha **prevalece** e sobrescreve o cadastro. |

Sobre o nome — normalmente você não digita nada, o ESNFS traz do cadastro:

- Cadastro encontrado e linha sem nome → usa o do cadastro, sem discussão.
- **Cadastro não encontrado e linha sem nome** → aquela NF falha com aviso
  pedindo o nome. As outras seguem.
- Diferença pequena (acento, “Wellington”/“Welliton”) → **mantém o do cadastro**.
- Cadastro abreviado e lista completa (“LUIZ F. C. O. M.” → “LUIZ FERNANDO
  CARDOSO OLIVEIRA MARTINS”) → **completa** pela lista.
- Lista abreviada e cadastro completo → **mantém o cadastro** (nunca piora o dado).
- Nome completamente diferente (primeiro nome não bate) → grava o da lista e
  **sinaliza em maiúsculas no relatório** para você conferir.

A UF de um cadastro válido **nunca** é trocada — trocar a UF apaga a cidade.
Um tomador de Chapecó/SC continua em Chapecó/SC.

### Constantes (ajustáveis no popup, em “Constantes e endereço padrão”)

| | |
|---|---|
| Serviço | `17.22.01.000 — Cobrança em geral` (`value=32761`) |
| Alíquota | `2,01` |
| Discriminação | Serviços de cobrança e recuperação de crédito prestados ao tomador… |
| Endereço padrão | Rua **Endereço desconhecido**, nº **0**, bairro **Endereço desconhecido**, CEP **85660000**, **Dois Vizinhos / PR** |

O prestador não é escolhido pela extensão: ela usa o que já está selecionado na
tela (COBRASQ, único do login).

---

## Se algo der errado

- **Uma NF falha** → é registrada com o motivo, o lote **continua** nas demais.
  No fim aparece o botão **Reprocessar N falha(s)**, que refaz só as pendentes.
- **Sessão caiu** → a extensão tenta reabrir a tela de emissão 3 vezes e então
  pausa com o aviso. Faça login de novo e clique em **Retomar**.
- **Pausar** → só interrompe **entre passos**, nunca no meio de um preenchimento.
  Se o formulário tiver ficado pela metade, a tela é recarregada limpa antes de
  seguir, para não somar dois serviços na mesma nota.
- **Fechar o popup não para nada** — quem executa é o script na página. Para
  parar de verdade, use **Parar** no painel.

⚠️ **Deixe a aba do ESNFS em primeiro plano durante o lote.** O Chrome desacelera
timers de abas em segundo plano; o lote não quebra, mas fica bem mais lento.

---

## Arquivos

| Arquivo | Papel |
|---|---|
| `manifest.json` | Manifest V3. Permissões: `storage`, `tabs` e o host `esnfs.com.br`. |
| `content.js` | Motor da automação: roda dentro da página do ESNFS. |
| `popup.html` / `popup.css` / `popup.js` | Tela de entrada: formulário de tomadores, validação e disparo. |

O estado do lote vive em `chrome.storage.local` (chave `nfseJob`), por isso a
automação sobrevive ao recarregamento de página que o **Gravar** provoca.

Nada sai da máquina: não há servidor, telemetria ou chamada externa. A extensão
só age em `esnfs.com.br`.

## Como isto foi testado

A automação foi rodada de ponta a ponta contra um **clone falso da tela do
ESNFS**, reproduzindo as manias do original (IDs com ponto, modais do Bootstrap,
alíquota zerada ao trocar o serviço, cidades por AJAX, navegação no Gravar).
Cenários cobertos: cadastro completo, sem endereço, vazio, nome divergente,
tomador de outra UF, endereço preenchido na linha, linha só com CPF, CPF sem
cadastro e sem nome, confirmação antes de gravar, e uma NF quebrada no meio do
lote (as outras seguiram normalmente).

Ainda **não foi rodada contra o ESNFS real** — por isso o padrão é pedir
confirmação antes da 1ª nota. Na primeira vez, rode em **Simulação** com um
tomador conhecido e confira os campos antes de soltar o lote inteiro.
