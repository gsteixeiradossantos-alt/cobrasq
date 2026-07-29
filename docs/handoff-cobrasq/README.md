# Handoff — Reformulação do painel COBRASQ

Redesign aprovado do menu lateral e de 9 telas. Aplicar em `index.html` (SPA vanilla HTML/CSS/JS, sem bundler).
Repo: `gsteixeiradossantos-alt/cobrasq` · branch `main`.

## Arquivos deste pacote

| Arquivo | Uso |
|---|---|
| `prototipo-referencia.html` | Protótipo navegável offline. Abrir e clicar por tudo. **Referência visual** (é React/streaming) — traduzir para vanilla, não copiar. |
| `COBRASQ Sistema v3.dc.html` | Fonte do protótipo, se precisar ler valores exatos. |
| `screenshots/01…12` | Uma por tela/estado (2x). |

Fidelidade: **alta**. Todos os hex, tamanhos, paddings e raios abaixo são finais — copiar literalmente.

---

## 1. Tokens (já existem no `index.html` — reusar, não criar)

```
ink        #0A1530   ink-2 #15224A
paper      #EFEAD9   paper-2 #E2DBC6
accent     #C9A961   accent-2 #9C7F40
fundo da página      #FBFAF6
card                 #FFFFFF
borda de card        #E6E1D2
divisória interna    #F2EFE6  (header de card: #EFEBE0)
header de tabela     #F7F4EC   linha selecionada #F6F3EA
verde   #5E7C58  bg #E9F0E7  texto #4C6647  borda #CFE0CB
vermelho #A65A4A  bg #FBEAE7  texto #7D3F33  borda #E7CFC7
âmbar   #9C7F40  bg #FBF3E1  texto #7A6428  borda #DFC992
azul    #3A5288  bg #E4EAF5
neutro  bg #F5F2EA  texto #6B7683
texto: #0A1530 primário · #5A5F66 corpo · #6B7683 secundário · #8A94A6 meta · #A6AEBD fraco
sidebar: fundo #0A1530 · item inativo #B4BCCC · ícone inativo #7E88A0 · ícone ativo #C9A961
         item ativo bg rgba(201,169,97,.14) + border-left 2px #C9A961 · grupo #6C7690
```

**Tipografia** — `Fraunces` (títulos de card, H1), `Inter Tight` (UI), `JetBrains Mono` (valores, datas, processos, labels uppercase). Eyebrow: mono 9,5–10px, `letter-spacing:.14em`–`.16em`, uppercase.

**Geometria** — card `radius:9px; border:1px solid #E6E1D2`, sem sombra. Chips `radius:20px`, badges `4px`, botões `6–7px`. Padding de card `16px`; header de card `14px 16px 12px`. Conteúdo da página `20px 24px 32px`, `gap:16px`. **Sidebar 228px**, topbar 52px, shell `min-width:1180px` (rola na horizontal — desktop-only).

---

## 2. Menu lateral

Cabeçalho: marca `cobrasq.` (Fraunces 18px, ponto em `#C9A961`), quadrado 26px `rgba(201,169,97,.16)` com dot dourado 9px, badge `v1` à direita. Abaixo, busca `⌘K`.

Item: `padding:7px 10px; gap:9px; font-size:13px`, ícone SVG 15px stroke 1.35 (paths no protótipo), rótulo, badge à direita. **O badge só existe quando há número** — não renderizar o `<span>` vazio (ele comia 21px de rótulo e causava clipping).

Badge vermelho `#A65A4A` = exige ação; badge `rgba(255,255,255,.10)` / texto `#9AA4BC` = informativo.

Agrupamento novo (todos os 26 itens preservados, 22 de nível 1):

| Grupo | Itens |
|---|---|
| HOJE | Painel · Tarefas (26) · Delegação · Audiências (11) |
| CARTEIRA | Cobranças (221) · QuitaFácil (9) · Assinaturas (1) · Devedores · Clientes |
| JURÍDICO | Intimações (99+) · Peças e ações judiciais · Rascunhos (5) · Consultas |
| DINHEIRO | Financeiro · Custódias e repasses (4) · Emitir NF (32) |
| CANAIS | WhatsApp (215) · Documentos · Importação |
| SISTEMA | Aprovações (3) · Calculadora · Configurações |

**Duas fusões de rota** (o resto é só reagrupamento):
- `#/intimacoes` + `#/intimvincular` + `#/intimurgentes` → **um item, três abas**. Manter as rotas antigas como aliases que abrem a aba certa.
- `#/repasses` + `#/custodias` → **um item, duas abas**. Idem.

Mudanças de grupo intencionais: Intimações saiu de COMUNICAÇÃO para JURÍDICO (é prazo, não canal); Documentos saiu de PRINCIPAL para CANAIS.

---

## 3. Painel > Visão geral

Ordem: cabeçalho → faixa de alerta → card **Acordos do mês** → grid 2 colunas.

1. **Cabeçalho** — eyebrow com a data; H1 Fraunces 26px "Boa tarde, Dr. Gustavo."; subtítulo com nº de itens que pedem decisão. À direita segmented `Hoje · Semana · Mês · Trim` (ativo `#0A1530`/branco) + selects de cliente e operador.
2. **Alerta** (só quando houver) — dot 26px `#A65A4A`, botão sólido à direita. Fonte: acordo assinado sem boleto.
3. **Acordos de julho** — 4 métricas em `repeat(4,1fr)`: ACORDADO NO MÊS · A RECEBER EM JULHO · META DO MÊS (`DB.config.metaMensal`) · **FECHAR POR DIA ÚTIL** `= (meta − recuperado) / dias úteis restantes`, em `#9C7F40`. Barra empilhada: recuperado (`#5E7C58`) + acordado a receber (`#C9A961`) sobre `#F2EFE6` + "% da meta comprometido".
4. **Grid** `minmax(0,1.55fr) minmax(320px,1fr)`:
   - Esquerda: **Precisa de decisão hoje** (chips Tudo/Cobrança/Dinheiro/Jurídico; linha = barra de risco 3px + nome/meta + valor mono + tag + botão de ação; rodapé "Mostrando N de 27") e **Carteira por situação** (barra 12px + 4 colunas).
   - Direita: card escuro CARTEIRA ATIVA (mono 26px) + recuperado/negociação + barra de meta dourada; **Próximos 7 dias** (7 células + compromissos); **Riscos silenciosos** (parado 90+, a prescrever ≤6 meses, boletos vencidos).

Saiu da tela atual: gráfico de projeção ilustrativo, aging duplicado, calendário mensal, card de atividade vazio, fila repetida. Aging e atividade seguem nos Relatórios.

Dados: `view_casos`, tarefas/lembretes, `acordos`/ZapSign, Asaas, `DB.config.metaMensal`.

---

## 4. Cobranças — o filtro é o coração da tela

O filtro antigo ("A agir / QuitaFácil / No judicial / Acordos / Todos / Encerrados") não diz o que fazer. Substituir por **pipeline de etapas**: 9 cards clicáveis (`min-width:110px; gap:6px`, barra de 3px no topo na cor da etapa, rótulo 12px, contagem mono 19px, valor mono 10,5px). Card ativo: fundo `#0A1530`, rótulo branco.

| Etapa | Cor | Próxima ação | Qtd · valor de referência |
|---|---|---|---|
| Todos | `#8A94A6` | a carteira inteira | 221 · R$ 1.861.131 |
| Cobrar | `#3A5288` | contato / régua de WhatsApp | 38 · R$ 121.400 |
| Negociando | `#C9A961` | aprovar ou recusar proposta | 11 · R$ 48.900 |
| Acordo ativo | `#5E7C58` | acompanhar parcelas | 17 · R$ 96.320 |
| **Fazer ação** | `#A65A4A` | redigir e protocolar a inicial | 31 · R$ 284.700 |
| Em ação | `#0A1530` | aguardar / responder o juízo | 68 · R$ 962.180 |
| Execução | `#15224A` | penhora, BacenJud, RenaJud | 23 · R$ 258.400 |
| Travado | `#9C7F40` | decidir: insistir ou baixar | 9 · R$ 44.531 |
| Encerrado | `#A6AEBD` | devolver título ao cedente | 24 · R$ 44.700 |

A distinção que faltava: **Fazer ação** (decidido, falta protocolar — dinheiro parado na mesa do gestor) ≠ **Em ação** (tramitando) ≠ **Execução** (cumprimento/penhora). "Travado" isola o que não anda.

Acima do pipeline, linha `ETAPA DO CICLO — O QUE FALTA FAZER` + "próxima ação nesta etapa: …".

**Recortes** (segunda linha, chips que **acumulam com AND** e cruzam com a etapa): Ação atrasada (26) · Prescrevendo (1) · QuitaFácil (9) · Sem contato há 30d (47) · Sem responsável (3). Ativo: bg `#FBF3E1`, borda `#DFC992`, texto `#7A6428`. Com algum ativo, mostrar "limpar recortes ✕".

**Contador à direita** — derivar da lista filtrada, nunca hardcode: `N de M casos após os recortes · R$ <soma dos exibidos>`. Um contador que discorda da lista é pior que nenhum.

**Tabela** — colunas: checkbox 16 · DEVEDOR flex `min-width:210` (barra de risco 3px + nome + papel + "título · alerta") · CREDOR 132 · FORO 150 (mono) · **PRÓXIMA AÇÃO 130** ("Redigir inicial", "Aprovar proposta", "Pedir BacenJud") · VALOR ATUAL 112 (valor + original menor) · ETAPA 104 (chip) · IDADE 56 · Abrir 32.

**Estado vazio obrigatório** dentro do card (9 etapas × 5 recortes torna zero-resultado fácil): "Nenhum caso nesta etapa com os recortes aplicados." + link "Limpar recortes", `padding:38px 16px`, centralizado. Nunca deixar o header de tabela sozinho.

**Barra de lote** (`position:sticky; bottom:0`, `#0A1530`, sombra `0 8px 24px rgba(10,21,48,.28)`): Disparar cobrança (verde sólido) · Criar tarefa · Mudar responsável · Mudar situação · Preparar petição · Exportar · "Limpar seleção ✕".

Topo da tela: alerta de prescrição + 4 KPIs (TOTAL EM ABERTO escuro · CASOS ATIVOS · NO JUDICIAL · VÁRIOS DEVEDORES) + busca e selects Credor/Responsável/Ordenação.

**A etapa precisa virar coluna no banco** (`casos.etapa` enum), não ser inferida em runtime — hoje o estado está espalhado entre situação, foro e tarefas. Migração + backfill a partir das regras atuais.

---

## 5. Tarefas

Kanban 4 colunas `repeat(4,minmax(240px,1fr))`: A fazer (12) · Fazendo (5) · Revisão (10) · Concluído (30), cada uma com dot colorido + contagem. Card: `radius:8px; padding:12px`, chip de prioridade + tipo, título 13px `line-height:1.4`, rodapé com responsável e `prazo · atraso` em `#A65A4A`. Rodapé da coluna: "+ Nova tarefa" tracejado.

Filtro de prioridade em chips (Todas/Alta/Média/Baixa) + selects Responsável e Tipo. Faixa de alerta: "26 tarefas atrasadas · a mais antiga venceu em 05/05" + "Repriorizar em lote".

## 6. Agenda (Audiências)

Card escuro no topo: PRÓXIMA AUDIÊNCIA (Fraunces 21px) · ESTA SEMANA · LEMBRETES NA FILA + botões "Ver lembretes" / "Abrir sala virtual" (dourado). Depois, **agrupamento por dia**: coluna de data à esquerda (62px: dow mono / dia Fraunces 28px / mês em `#9C7F40`) e cards de audiência à direita com hora mono 16px + AGENDADA, tipo + processo, partes, comarca/sala, coluna LEMBRETES ("véspera · dia · 10min") e ações "Marcar realizada" / "Editar".

## 7. Intimações (3 telas → 1)

Abas `Andamentos (67 não lidos)` · `A vincular (38)` · `Urgentes (fora do Paraná · 9)`.

- **Andamentos** — card "Fila de peticionamento" (chips verdes com processo + PROTOCOLADO/tipo) e tabela: dot de não-lido 8px `#A65A4A` (opacidade 0 quando lida) · FONTE 70 (DATAJUD/PROJUDI/EPROC) · PROCESSO 186 (número + devedor) · MOVIMENTAÇÃO flex · DATA 52 · ações **Gerar peça (Bia)** (escuro) + Marcar lida. Linha lida: fundo `#FBFAF6`, nome peso 400.
- **A vincular** — cards com data/tribunal/sistema, processo, movimentação, partes e **CASO SUGERIDO** (o match automático) + "Vincular ao caso" / "Descartar". Vinculado: borda `#CFE0CB`, fundo `#F4F8F3`, botão "✓ Vinculado". Header com "Vincular sugeridos em lote".
- **Urgentes** — lista com tribunal em `#A65A4A` e chips CONTRA NÓS / PRAZO / VINCULADO + Vincular/Arquivar. Explicar no subtítulo por que existem (tribunais fora do TJPR não entram no monitoramento automático).

## 8. Custódias e repasses (2 telas → 1)

Abas `Custódias` · `Repasses`.
- **Custódias** — 3 KPIs (EM CUSTÓDIA escuro · RISCO DE PRESCRIÇÃO · A DEVOLVER AO CEDENTE) + tabela: TÍTULO (+ "em custódia há N") · CEDENTE · DEVEDOR · VALOR · ONDE ESTÁ (cofre/autos/devolvido) · SITUAÇÃO.
- **Repasses** — a mesma fila que aparece em Financeiro · Recebíveis, aqui com link de comprovante. **Uma fonte de dados só** — não duplicar a lógica.

## 9. Notas fiscais (Emitir NF)

4 KPIs que classificam por **prontidão**: A EMITIR (escuro) · PRONTOS AGORA (3, borda verde) · FALTA ENDEREÇO (6, âmbar) · SEM IDENTIFICAÇÃO (22, vermelho). Tabela: checkbox (**desabilitado quando não está pronto** — fundo `#F5F2EA`) · PAGADOR + CPF · CADASTRO (cor conforme o status) · MEIO · RECEBIDO · VALOR · ação "Emitir NF" ou "Completar dados".

Barra de lote: Emitir NF em lote (verde) · Buscar endereço no Asaas · Dispensar.

## 10. WhatsApp

O achado da tela: **a régua nunca rodou** — 215 elegíveis, 0 enviadas, só a etapa D+2 existe. Isso é o alerta âmbar principal, com "Ativar régua". Depois, editor de **cadência** (D+2 / D+7 / D+15 / D+30, canal, texto do template em caixa `#FBFAF6`, chip ATIVA/RASCUNHO/SUGERIDA, Editar) + card escuro CONTATOS ELEGÍVEIS/ENVIADAS/TAXA DE RESPOSTA + "Precisam de resposta" (conversas com tag RESPONDER/AGUARDA).

## 11. Financeiro — 3 abas

`Caixa · Movimentações · Recebíveis` (as 5 antigas somem: Inadimplência & Execução entra em Recebíveis; Cadastros → Configurações; Relatórios → módulo Relatórios). Aba ativa `border-bottom:2px solid #C9A961`.

- **Caixa** — 4 KPIs (`1.15fr 1fr 1fr 1fr`) + alerta de lançamentos em atraso + grid `minmax(0,1.6fr) minmax(300px,1fr)`: fluxo de caixa 30 dias (barras duplas entrada `#5E7C58` / saída `#D8B7AF`), últimas 6 movimentações com atalho pra aba completa; à direita Contas, DRE por categoria, Top despesas.
- **Movimentações** — filtros TIPO e SITUAÇÃO (trocar filtro limpa a seleção), tabela com checkbox e selecionar-todos (respeita o filtro), rodapé com ENTRADAS/SAÍDAS/LÍQUIDO **do filtro**, barra de lote: **Confirmar pagamento** (verde) · Conciliar · Alterar categoria · Alterar conta · Reagendar · Excluir. Mapeia `fin_lancamento` (+ `fin_lancamento_categoria`, `fin_conta`); **lote = uma transação por ação**, com toast e undo simples.
- **Recebíveis** — 4 KPIs + card **Assinado → lançar → repassar** + fila de repasses + inadimplência + composição dos recebíveis + card escuro "Divisão do recuperado".
  - `Lançar parcelas` cria N `fin_lancamento` previstos das parcelas do acordo (vencimento, valor, categoria Recuperação, conta Asaas, `status=0`).
  - `Cadastrar repasse` abre modal com o valor do credor pré-calculado (bruto − honorário do contrato do cedente) e cria a pendência.
  - **Idempotência obrigatória**: chave (`acordo_id`, `numero_parcela`) — dois cliques não podem duplicar.

---

## 12. Interações a implementar

- Navegação da sidebar sem reload; breadcrumb do topbar acompanha página **e aba**; botões de ação do topbar mudam por página.
- Segmented de período no Painel recalcula recuperado / negociação / meta.
- Cobranças: pipeline (single), recortes (multi, AND), contador derivado, estado vazio, seleção em lote.
- Tarefas: chips de prioridade filtram as colunas.
- Intimações e Custódias: abas sem reload; "Marcar lida" e "Vincular" idempotentes.
- NF: seleção só de itens prontos.
- Hover de linha `#FBFAF6`. Foco `box-shadow:0 0 0 2px rgba(10,21,48,.2)`.
- Loading: skeleton no formato do card. Vazio: texto curto centralizado — **nunca** card vazio.

## 13. Armadilhas (todas custaram bug no protótipo)

1. Card com `overflow:hidden` dentro de coluna flex com scroll precisa de **`flex-shrink:0`**, senão colapsa para altura 0.
2. Coluna de texto flexível ao lado de colunas fixas precisa de `min-width` (180–210px), não `min-width:0`.
3. Badge/elemento condicional vazio ainda ocupa padding + gap — renderizar condicionalmente, não pintar transparente.
4. Contadores de filtro precisam vir do array filtrado, nunca de tabela fixa.
5. Não usar `zoom` no `#page-fin` (hoje há `zoom:1.08`) — usar os tamanhos reais deste handoff.
6. Cuidado com `*/` dentro de comentário CSS no `index.html` (já quebrou o app).

## 14. Aceite

- [ ] Sidebar com 6 grupos, 22 itens, ícones, sem rótulo cortado; badge ausente não ocupa espaço.
- [ ] `#/intimacoes`, `#/intimvincular`, `#/intimurgentes` abrem a aba correta da tela única; `#/repasses` e `#/custodias` idem.
- [ ] Cobranças: 9 etapas filtram; recortes acumulam; contador == linhas exibidas; zero-resultado mostra mensagem.
- [ ] Coluna PRÓXIMA AÇÃO preenchida para todas as etapas.
- [ ] Painel sem gráfico de projeção, sem calendário mensal, sem card vazio; "fechar por dia útil" confere.
- [ ] Financeiro com 3 abas; lote confirma pagamento de 2+ lançamentos numa transação.
- [ ] Acordo assinado gera lançamentos previstos **e** pendência de repasse, sem duplicar.
- [ ] Layout íntegro em 1280 e 1440px; abaixo de 1180 rola na horizontal.

## 15. Prompt sugerido para o Claude Code

> Leia `docs/handoff-cobrasq/README.md` e compare com os PNGs em `screenshots/` e com `prototipo-referencia.html` (referência visual em React — traduzir para HTML/CSS/JS vanilla). Aplique no `index.html` nesta ordem, um diff por etapa: (1) menu lateral reagrupado com ícones e badge condicional, incluindo os aliases de rota das duas fusões; (2) Cobranças com o pipeline de 9 etapas, recortes AND, contador derivado, coluna Próxima ação, estado vazio e ações em lote — criando a coluna `casos.etapa` com migração e backfill; (3) Painel > Visão geral; (4) Financeiro em 3 abas com a aba Movimentações e o bloco "Assinado → lançar → repassar"; (5) Intimações unificada em 3 abas; (6) Custódias e repasses unificada; (7) Tarefas, Agenda, Notas fiscais e WhatsApp. Use os tokens existentes do `index.html`, não invente cores. Mantenha `/api/*` e as migrações anteriores intactas.
