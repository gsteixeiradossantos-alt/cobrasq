# Matriz de cálculo — `templates/calc-engine.js`

**Fonte única** das contas de dívida do sistema. Antes, cada tela tinha sua própria
cópia (idêntica) do motor e tabelas de índice duplicadas — mudar uma fórmula ou o
índice do mês exigia editar **13 tabelas em 3 arquivos**. Agora: **muda na matriz,
vale em todo lugar.** As telas viraram "filiais" finas que só chamam o motor.

## O que a matriz expõe (`CalcEngine`)
| API | O que faz |
|---|---|
| `CalcEngine.TABELAS` | `{INPC, IPCA, IGP-M, IGP-DI, SELIC, TJPR, TAXA-LEGAL}` — variação % mês a mês. **Atualizar aqui 1×/mês.** |
| `CalcEngine.INDICES_ATE` | `'AAAA-MM'` até onde os índices estão preenchidos (avisos de defasagem). |
| `CalcEngine.correcaoMensal(valorIni, dataIni, dataFim, indice)` | Correção monetária composta, mês fechado → `{valorCorrigido, mesesAplicados}`. |
| `CalcEngine.juridica(valor, dataIni, dataFim, indice, multaPct, honPct, jurosMensalPct)` | Conta da **peça/memorial**: correção + juros pró-rata + multa + honorários + garantia STJ. |
| `CalcEngine.cobranca({valorOriginal, meses, correcaoMensal, jurosMensal, multaPct, taxaServico, aplicarMulta, aplicarTaxa})` | **Núcleo extrajudicial**: correção + juros + multa + taxa de serviço, total arredondado pra cima. O chamador passa `meses` e os parâmetros (preserva o número de cada origem). |

Módulo **puro** (sem DOM/rede), dual-mode (global no browser + CommonJS nos testes),
servido de `templates/` para **não** cair no rewrite catch-all do `vercel.json`
(mesmo motivo do `termo-engine.js`).

## Quem consome hoje (filiais)
- **`index.html`** — `_petCalcJuridica` → `juridica`; `calcDividaCobranca` → `cobranca`.
- **`crm.html`** — `_calcJuridicaMemorial` → `juridica`; `_pecaAplicarCorrecaoMensal` →
  `correcaoMensal`; `_calcCobrancaSimples` → `cobranca` (núcleo; parcelamento
  boleto/cartão segue inline, é exclusivo do CRM); `PECA_INDICES_ATE = CalcEngine.INDICES_ATE`.
- **`calc-juridica.html`** — carrega `<script src="/templates/calc-engine.js">` e usa
  `CalcEngine.calcularJudicial` / `CalcEngine.TABELAS` (calculadora standalone, já migrada).

## Atualização mensal dos índices (o ganho)
**Automática desde 12/09/2026:** o workflow `.github/workflows/atualizar-indices.yml` roda nos
dias 12 e 16, chama `scripts/atualizar-indices.mjs` (BCB/SGS → `CalcEngine.TABELAS`, só meses
fechados, nunca sobrescreve valor já gravado) e abre o PR `bot/indices-AAAA-MM`. **O merge é
humano** — conferir os valores contra a fonte antes. O job `indices-atualizados` do CI fica
vermelho a partir do dia 16 se o mês anterior ainda faltar (não trava o `test-and-lint`).
À mão: `node scripts/atualizar-indices.mjs` (ou `--check` para só conferir).
Peça, memorial, cobrança do painel/CRM e a calc-jurídica usam o valor novo automaticamente
depois do merge. A calc-jurídica ainda sincroniza do BCB ao abrir (`syncBCB`), mas só meses
fechados — o mês em curso nunca entra (era o erro do #509).

Regra do motor que justifica a pressa: **mês sem índice na tabela vale 0%** (`calc-engine.js`,
`varPct === undefined → 0`), sem aviso. O único sinal é o "Índices até AAAA-MM" no PDF.

## Testes
`npm test` (inclui `test/calc_engine.test.js`) ou, sem Node:
`jsc templates/calc-engine.js test/calc_engine.test.js`.
O teste faz *fuzz* de 200 casos jurídicos + 200 de cobrança contra um **oráculo com a
fórmula original verbatim** — prova de que centralizar **não muda número**.

---

## NÃO migrado nesta fase (decisão pendente — mudaria número)
Estas contas usam **algoritmo/série diferentes** do motor; unificar exige sua decisão
porque **altera valores**. Ficaram intactas:

1. **`index.html` `calcDividaAtualizada` / `CALC_INPC_MENSAL`** (execução). Usa série INPC
   **desde 2020**, garantia STJ por fator acumulado e juros pró-rata **por dias** — não é
   a conta `dias/30` da peça. Migrar = mesclar o histórico 2020+ na matriz e reconciliar
   o algoritmo.
2. **`index.html` `petComputeCalc`** (chat da Bia). Honorários com base possivelmente
   diferente (`subtotalGeral * hon%`) do motor (`(atualizado+juros+multa) * hon%`).

> **Nota (PR #183, item 3 — resolvido):** a `calc-juridica.html` **já foi migrada** e hoje
> consome `CalcEngine.calcularJudicial` / `CalcEngine.TABELAS`. As antigas
> `calcularPrincipal` / `segmentarPorMes` com `TABELA_*_EMBUTIDA` não existem mais.

## Divergências reais que a matriz NÃO escondeu (para decidir — "fase B")
A centralização preservou o comportamento atual de propósito; estas duas divergências
**continuam existindo** e merecem decisão:

- **Cobrança — fonte de juros/multa.** O painel (`calcDividaCobranca`) lê juros/multa do
  **admin** (`getCalcParams()` → `DB.config.calcParams`); o CRM (`_calcCobrancaSimples`)
  usa **constantes chumbadas** (`TAXA_JUROS_MENSAL=0.01`, `MULTA_PCT=0.02`). Hoje coincidem
  (mesmo default), mas **se você mudar no admin, o CRM não obedece.** Unificar = o CRM
  passar `getCalcParams()` no lugar das constantes.
- **Honorários da Bia** (item 2 acima): alinhar a base antes de migrar `petComputeCalc`.

Quando quiser fechar esses pontos, é a "Opção B" da auditoria (mexe em valores; mostro o
antes/depois de cada caso afetado antes de aplicar).
