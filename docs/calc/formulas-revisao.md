# Revisão de fórmulas — Calculadora Jurídica COBRASQ (C1)

Origem: triagem Fase E, item C1. Doc preparado pra revisão colaborativa Gustavo + Claude.

Cada fórmula abaixo tem: descrição, snippet do código atual, fórmula matemática, base legal, e ponto de atenção. **Marque ✅ se estiver OK, ⚠ se precisar ajuste, e comente.**

---

## 1. Correção monetária — INPC/IPCA/IGP-M/TJPR

### Lógica atual

`calcularPrincipal()` (linha 1106) segmenta o intervalo `[dataCorrecao, dataFim]` mês a mês via `segmentarPorMes()`. Para cada segmento:

```js
const varPct = TABELAS[info.tabela][ch];        // variação % do mês (ex: INPC ago/2025 = 0,4521)
const varEf = (varPct/100) * (s.diasSeg / s.diasMes);  // pro rata die linear
const fatorMes = 1 + varEf;
saldoCorrigido = saldoCorrigido * fatorMes;
```

### Fórmula

Para cada mês `m` do período:
$$
\text{saldoCorrigido}_m = \text{saldoCorrigido}_{m-1} \times (1 + \frac{\text{indice}_m}{100} \times \frac{\text{diasSegmento}}{\text{diasMes}})
$$

### Base legal

- **INPC**: índice oficial do IBGE pra correção monetária da maioria das obrigações cíveis (Súmula 459 STJ)
- **TJPR**: a Corregedoria do TJ-PR fixou que a Tabela Prática usa INPC (sigla TJPR aliasa pra INPC)
- **Pro rata die linear**: cálculo proporcional aos dias do segmento (não capitalização diária)

### ⚠ Ponto de atenção

- **TJPR no PR**: a Corregedoria pode ter atualizado pra usar IPCA pós-Lei 14.905/24. Confirmar no Provimento atualizado.
- **Cálculos pré-1994**: IPCA/INPC têm rupturas (Plano Real, troca de moeda). Não tratado — fórmula assume continuidade.

**[ ] OK** | **[ ] Ajustar** — comentário: 

---

## 2. Juros de mora — capitalização simples

### Lógica atual

`calcularPrincipal()` (linha ~1164):

```js
jurosMes = saldoCorrigido * (params.taxaJurosMensal/100) * (diasJurosNoSeg/30);
jurosAcumulados += jurosMes;
```

### Fórmula

Para cada mês `m` a partir de `dataJuros`:
$$
\text{jurosMes}_m = \text{saldoCorrigido}_m \times \frac{\text{taxa}}{100} \times \frac{\text{diasJurosNoSegmento}}{30}
$$

$$
\text{jurosAcumulados} = \sum_m \text{jurosMes}_m
$$

### Base legal

- **Art. 406 CC** (redação anterior à Lei 14.905/24): juros de 1% a.m. (taxa legal)
- **Art. 406 CC** (redação Lei 14.905/24, vigente desde 30/08/2024): SELIC – IPCA, capitalização simples
- **Súmula 121 STF**: vedação à capitalização (juros simples, não compostos)

### ⚠ Pontos de atenção

1. **Base do juros** = **saldo corrigido** (não valor original). Isso é o padrão STJ pra obrigações em moeda nacional. Confirmado.
2. **Capitalização simples**: juros não capitalizam (não rolam pro mês seguinte como base de novos juros). Conforme Súmula 121 STF.
3. **Pro rata die "/30"**: divisor é 30 dias (não 28-31). Aproximação consagrada (CC art. 132 §3º).

**[ ] OK** | **[ ] Ajustar** — comentário: 

---

## 3. SELIC — trava de juros

### Lógica atual

Quando `indice = SELIC`, `getIndiceParaSegmento()` retorna `{tabela: 'SELIC', travaJuros: true}`. No loop:

```js
if (info.travaJuros && params.dataJuros <= s.dataFimSeg) {
  // SELIC já embute juros — não acumula juros adicionais
} else {
  jurosMes = saldoCorrigido * ...
}
```

### Fórmula

Quando índice = SELIC, $\text{jurosMes} = 0$ pra todos meses (a SELIC já é taxa nominal mensal acumulada).

### Base legal

- **STJ Tema 905** (REsp 1.495.146/MG): SELIC engloba correção + juros, não cumular
- **CC art. 406** redação Lei 14.905/24: cálculo é "SELIC – IPCA"; aplicação direta da SELIC (sem subtrair IPCA) é simplificação aceita pelos tribunais quando o credor opta

### ⚠ Pontos de atenção

1. **SELIC integral vs SELIC – IPCA**: a calc usa SELIC integral (mais favorável ao credor). Pra aplicação literal da Lei 14.905/24, deveria ser SELIC – IPCA. **Decisão:** simplificação aceita (usar SELIC integral) ou aplicar a fórmula correta?
2. **Pré-30/08/2024**: SELIC só pode ser retroativa com decisão judicial expressa (`selicRetroativo` checkbox + justificativa). Implementação OK.

**[ ] OK** | **[ ] Ajustar** — comentário: 

---

## 4. Multa contratual

### Lógica atual

`calcularPrincipal()` (linha ~1169-1182):

```js
if (params.aplicarMulta && multaAcumulada === 0 && dataMulta <= s.dataFimSeg) {
  if (params.multaTipo === 'FIXO') {
    multaAplicadaEsteSeg = params.multaPct;  // valor direto em R$
  } else {
    let baseM = saldoCorrigido + jurosAcumulados;  // base CORRIGIDO_JUROS (fixo após C7)
    multaAplicadaEsteSeg = baseM * (params.multaPct/100);
  }
  multaAcumulada = multaAplicadaEsteSeg;
}
```

### Fórmula

Aplica uma única vez quando `dataMulta` é atingida:
- **Tipo PCT:** $\text{multa} = (\text{saldoCorrigido} + \text{jurosAcumulados}) \times \frac{\text{percentual}}{100}$
- **Tipo FIXO:** $\text{multa} = \text{valor R\$ informado}$

A multa **NÃO compõe base de juros futuros** — entra como linha separada no fechamento.

### Base legal

- **Art. 408-413 CC**: cláusula penal moratória, limitada ao valor da obrigação principal
- **CDC art. 52 §1º**: multa de mora máxima de 2% nas relações de consumo
- **Súmula 379 STJ**: aplicação de juros sobre multa contratual

### ⚠ Pontos de atenção

1. **Multa não capitaliza com juros**: confirmado, sai como linha separada. Mas na soma final entra como base pra honorários (per C4).
2. **Limite 2% relação de consumo**: app não valida — operador precisa atentar.
3. **Termo de incidência** (`multaData`) — default é `dataJuros` se vazia. Razoável? Ou deveria ser `dataCorrecao`?

**[ ] OK** | **[ ] Ajustar** — comentário: 

---

## 5. Honorários (contratuais simplificados — pós C4)

### Lógica atual

`calcularHonorario(grupo, params, baseRef)` (linha 1261):

```js
let valorNominal;
if (grupo.tipo === 'FIXO') {
  valorNominal = grupo.valor;
} else {
  let base = baseRef.saldoCorrigido + baseRef.jurosAcumulados + baseRef.multaAcumulada;
  valorNominal = base * (grupo.valor/100);
}
```

Honorários têm **correção e juros próprios** (em paralelo ao principal):

```js
const dCorr = grupo.dataCorr || params.dataCorrecao;
const dJur = grupo.dataJuros || params.dataJuros;
// ... loop similar a calcularPrincipal mas sobre valorNominal
```

### Fórmula

$$
\text{honorário}_{nominal} = (\text{saldoCorrigido} + \text{juros} + \text{multa}) \times \frac{\text{percentual}}{100}
$$

Esse valor é então corrigido e ganha juros próprios entre `[dataCorr, dataFim]`.

### Base legal

- **Lei 8.906/94 (Estatuto OAB) art. 22**: honorários contratuais e sucumbenciais
- **CPC art. 85**: sucumbenciais (mas removidos da calc per Q4)
- **STJ:** honorários contratuais são parte da reparação ao credor; podem incidir sobre principal+correção+juros+multa

### ⚠ Pontos de atenção

1. **Base = corrigido+juros+multa**: pós C4, é fixa. OK pra contratuais. **Mas:** alguns contratos especificam só sobre "principal nominal" (valor original). App não suporta isso — sempre usa soma. Confirmar se aceita.
2. **Correção e juros próprios dos honorários**: a calc corrige o valor nominal de honorários como uma "subdívida" autônoma. Está correto? Ou deveriam apenas serem cobrados nominalmente sobre o total atualizado?
3. **Pós C9** (multi-parcela): honorários incidem sobre **soma** de todas parcelas+correção+juros+multa. Confirmado em C3.

**[ ] OK** | **[ ] Ajustar** — comentário: 

---

## 6. Imputação de pagamento (art. 354 CC)

### Lógica atual

Eventos (pagamentos) são aplicados na ordem `['juros', 'multa', 'principal']`:

```js
const ordemCustom = ['juros','multa','principal'];
// se overrideImputacao=true, ainda usa essa ordem mas registra justifImputacao
```

### Fórmula

Pagamento de R$ X feito em data D:
1. Quita juros vencidos primeiro (`saldoJuros = max(0, jurosAcumulados - X)`)
2. Quita multa em segundo
3. Restante abate principal corrigido

### Base legal

- **CC art. 354**: "Havendo capital e juros, o pagamento imputar-se-á primeiro nos juros vencidos, e depois no capital, salvo estipulação em contrário, ou se o credor passar quitação por conta do capital."
- **Override:** quando há acordo expresso ou decisão judicial alterando ordem.

### ⚠ Pontos de atenção

1. **Ordem hardcoded**: `juros → multa → principal`. CC art. 354 fala "juros vencidos" e "capital", sem mencionar multa. **Multa entra entre os dois?** A jurisprudência diverge. Alguns tribunais imputam multa antes do principal (como acessório), outros depois.
2. **Override sem permitir reordenar**: o checkbox `overrideImputacao` exige justificativa mas mantém a ordem. Se a decisão judicial pediu ordem custom, a calc não suporta. **Limitação conhecida.**
3. **Pagamento parcial dentro do período**: o evento dispara em data D, mas a partir de D os juros continuam correndo sobre o saldo restante. Engine implementa isso? Confirmar via teste.

**[ ] OK** | **[ ] Ajustar** — comentário: 

---

## 7. Extrapolação de índice (C6)

### Lógica atual

`calcularPrincipal()` linha ~1078:

```js
let varPct = TABELAS[info.tabela][ch];
if (varPct === undefined) {
  // C6: usa último índice publicado
  const todasAsChaves = Object.keys(TABELAS[info.tabela]).sort();
  const ultimaChave = todasAsChaves[todasAsChaves.length - 1];
  varPct = ultimaChave ? TABELAS[info.tabela][ultimaChave] : 0;
}
```

### Comportamento

Se BCB ainda não publicou o índice do mês requisitado, usa o **último mês publicado**. Sinaliza no resultado: `⚠ Cálculo extrapolado em N mês(es) (a partir de DD/MM, INPC não publicado)`.

### ⚠ Pontos de atenção

1. **Não inventa números**: replica o último real. Aproximação razoável pra estimativa rápida.
2. **Uso processual**: em peças judiciais, o ideal é atualizar BCB primeiro (botão escondido pós C6, mas ainda existe). **Considerar bloquear `exportarPDF()` quando há extrapolação?** Forçaria operador a atualizar antes de gerar memorial.
3. **Margem de erro**: depende da volatilidade do índice. INPC pode variar 0-2% mês a mês — após 3+ meses extrapolados, divergência acumula.

**[ ] OK** | **[ ] Ajustar** — comentário: 

---

## Próximos passos

1. Você marca ✅ ou ⚠ em cada fórmula acima
2. Onde tiver ⚠, comenta o que mudaria
3. Revisamos juntos os ⚠ e ajusto o código + atualizo este doc
4. Doc final fica aqui como referência técnica

**Não há urgência** — esta revisão é pra ficar tranquilo de defender o cálculo em juízo, não pra corrigir bugs reportados.
