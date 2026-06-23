# Integração eproc TJPR — viabilidade e intermediadores

> Análise de viabilidade para **(1) alertas de andamento** e **(2) protocolar petições
> (iniciais e intercorrentes)** no novo **eproc do TJPR** (em implantação gradual, consolidação
> em 2026, substituindo o Projudi).
>
> Conclusão curta: **não dá para integrar direto no eproc** — o canal oficial (MNI/CNJ) é
> restrito ao Judiciário. O caminho viável é via **intermediadores**, separando claramente
> **leitura** (andamentos/intimações) de **escrita** (peticionamento).

## 1. Por que não dá para falar direto com o eproc

- O eproc expõe um web service oficial no padrão **MNI (Modelo Nacional de Interoperabilidade)
  do CNJ**, mas o uso é **autorizado apenas a órgãos da estrutura do Judiciário** (STF, STJ,
  tribunais, MP, Defensoria, procuradorias). Um app privado de cobrança/CRM **não credencia**
  nesse canal.
- A **"Consulta Pública"** do eproc **não é API**: é tela web e exige **número do processo +
  chave** caso a caso. Inviável para automação em escala.
- Portanto: existe divulgação de API, porém é porta fechada para terceiros comerciais.

## 2. Leitura — alertas de andamento (read)

Operação de baixo risco. Opções, da mais barata à mais completa:

| Fonte | O que entrega | Custo | Latência | Cobre TJPR/eproc | Status no projeto |
|---|---|---|---|---|---|
| **DataJud (CNJ)** | Andamentos/metadados oficiais | Grátis | ~24-48h | Sim (`api_publica_tjpr`) | Previsto, **não implementado** |
| **Escavador (DJEN)** | Intimações em tempo real por OAB | ~R$200-400/mês | Tempo real | Sim | Schema + stub prontos; falta contratar/deploy |
| **Codilo** | API consulta + monitoramento (PJe, eSAJ, Projudi, eProc) | Pago | Minutos/horas | Sim | Não avaliado/contratado |
| **Judit.io** | API consulta + monitoramento eproc | Pago | Minutos/horas | Sim | Não avaliado/contratado |

**Recomendação (leitura):** manter o combo já desenhado em `docs/setup/escavador.md` —
**DataJud** (andamentos, grátis) + **Escavador** (intimações em tempo real). Codilo/Judit
ficam como alternativa caso se queira tudo numa API só de monitoramento.

DataJud — endpoint oficial do Paraná:
```
POST https://api-publica.datajud.cnj.jus.br/api_publica_tjpr/_search
Authorization: APIKey <chave_publica_cnj>
```

## 3. Escrita — protocolar petições (write) ⚠️

Aqui mora o ponto sensível. **Peticionar é assinar como advogado.** Nenhum intermediador
protocola "como a Cobrasq": o protocolo no eproc exige a **identidade autenticada do
advogado** — login/senha do advogado **ou** **certificado digital (A1/A3)**. Na prática, os
intermediadores de peticionamento são **RPA/automação que usam o certificado A1 do advogado**
(Gustavo) para assinar e enviar. Implicações:

- É preciso **certificado A1** do advogado disponível ao serviço (responsabilidade e custódia
  da credencial — avaliar com cuidado).
- A responsabilidade pelo ato processual continua sendo do advogado.
- Não é algo que o app faça sozinho contra o eproc; depende do intermediador + certificado.

Intermediadores que fazem **escrita/protocolo** (não só consulta):

| Intermediador | Protocola inicial + intercorrente | API p/ automação | Requisito | Observação |
|---|---|---|---|---|
| **Projuris Peticiona** (ex-PeticionaMais) | Sim | Sim (alto volume, lote até 500) | Certificado **A1** | Candidato mais concreto com API; ajusta PDF ao tamanho/split do tribunal |
| **Doc9 / Loope** | Sim (RPA) | Parcial | Certificado A1 | Forte em RPA de protocolo |
| **Solucionare** | Sim | Sim | Certificado A1 | Integração de peticionamento + publicações |

> ⚠️ Confirmar **diretamente com o fornecedor** a cobertura específica do **eproc TJPR**
> (sistema novo, em implantação) antes de contratar — a maioria lista "eProc" genérico, mas a
> instância do TJPR é recente.

**Recomendação (escrita):** avaliar **Projuris Peticiona** como intermediador de
peticionamento via API. Exige contratação + certificado A1 do Gustavo + validação de cobertura
do eproc TJPR.

## 4. Arquitetura proposta (resumo)

```
                ┌──────────────── LEITURA (read) ────────────────┐
  DataJud (grátis) ── andamentos ─┐
  Escavador (DJEN) ── intimações ─┴──► Supabase (proc_intimacoes / metadata)
                                        └──► UI: widget home + /intimacoes + push

                ┌──────────────── ESCRITA (write) ───────────────┐
  App gera PDF da petição ──► Intermediador (Projuris Peticiona) ──► assina c/ A1 ──► eproc TJPR
                                        ◄── retorno: nº protocolo/status ──► Supabase
```

## 5. O que é construível AGORA (sem contrato/credencial externa)

- **DataJud cron**: job diário que consulta a API pública do CNJ para cada
  `devedores.encaminhamento_judicial.processoNum`, atualiza andamentos/metadados e dispara
  alerta quando há movimentação nova. **Único item buildável sem depender de terceiros.**

Tudo o que envolve **intimações em tempo real** (Escavador) e **peticionamento** (Projuris/A1)
depende de **contratação + credenciais** que estão fora do alcance do código.

## 6. Decisões pendentes (do Gustavo)

1. Contratar **Escavador** (intimações) — token + OAB. Ver `docs/setup/escavador.md`.
2. Contratar **Projuris Peticiona** (ou Solucionare/Doc9) para peticionamento — e disponibilizar
   **certificado A1**. Confirmar cobertura do **eproc TJPR** com o fornecedor.
3. Autorizar implementação do **DataJud cron** (parte gratuita, sem dependência externa).
