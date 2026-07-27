---
name: verificar-socios
description: >-
  Verifica vínculos societários de um devedor a partir do CPF/CNPJ e aplica o
  resultado em duas frentes. CNPJ → sócios (quadro societário/QSA); CPF → empresas
  no nome da pessoa (casando nome completo + os 6 dígitos do meio do CPF). Use ao
  montar um ACORDO (incluir o sócio/empresa como avalista/signatário) OU ao preparar
  uma AÇÃO JUDICIAL (incluir sócios no polo passivo / instruir desconsideração da
  personalidade jurídica). Dispara com: "verificar sócios", "empresas no nome do
  devedor", "quem é o sócio", "incluir avalista", "polo passivo", "desconsideração
  da personalidade jurídica", "sócio da empresa devedora".
---

# Verificar sócios / empresas do devedor

Ferramenta de due diligence societária da COBRASQ. Dado o documento do devedor,
descobre com quem ele se relaciona societariamente e prepara esses dados para
**acordo** (avalista) ou **ação judicial** (polo passivo / desconsideração).

## O que ela responde

- **Devedor PJ (CNPJ):** quem são os **sócios** (nome, CPF mascarado, qualificação).
- **Devedor PF (CPF):** em quais **empresas** a pessoa é sócia (busca reversa por nome,
  confirmada pelos 6 dígitos visíveis do CPF).

## Como consultar

O código já existe no repo — use estas entradas, não reinvente:

### 1. CNPJ → sócios (grátis, sem depender de carga)
- No app (browser): `cnpjSociosLookup(cnpj)` em `index.html`. Fonte 1 **CNPJá Open**
  (`https://open.cnpja.com/office/{cnpj}` → `company.members[]`), fonte 2 **BrasilAPI**
  (`/api/cnpj/v1/{cnpj}` → `qsa[]`). Retorna `{ ok, fonte, socios:[{nome, doc, papel}] }`.
- O CPF de cada sócio vem **mascarado** (`***.XYZ.WV*-**`). Isso é normal e público.

### 2. CPF → empresas (busca reversa)
- **Fonte primária (grátis):** base pública da Receita Federal carregada no Supabase.
  Chame a RPC **`buscar_empresas_por_socio(p_nome, p_cpf)`** (migração
  `supabase/migrations/2026-07-27_rf_cnpj_socios.sql`). Ela casa o nome (trigram,
  acento-insensível) e confere os **6 dígitos do meio** do CPF contra o CPF mascarado
  do sócio. Retorna `cnpj, nome, papel, situacao, confere`.
- **Proxy do app:** `POST /api/automacao?action=cnpja` (`api/_cnpja.js`, exige login
  Supabase) com `{ nome, cpf }`. Ele consulta a RPC primeiro; se a base não estiver
  carregada, cai no **CNPJá Comercial** quando `CNPJA_TOKEN` está setada; sem nada,
  responde `{ pendente:true, fallbackUrl }` (busca manual na Casa dos Dados).
- **Carga da base:** `scripts/import_cnpj_rf.py --uf PR` (só Paraná por enquanto).

### Confirmação de identidade — a regra do "miolo"
O QSA público mascara o CPF deixando visíveis **só os 6 dígitos centrais** (posições
4–9). Com o CPF completo do devedor, pegue esses 6 dígitos e bata contra o CPF
mascarado do candidato: **nome reduz os candidatos, o miolo elimina homônimo.** Nunca
trate um homônimo como confirmado sem o miolo bater (`confere === true`).

## Aplicação 1 — ACORDO (incluir avalista)

Objetivo: reforçar a garantia do acordo incluindo o sócio (se o devedor é a empresa)
ou a empresa (se o devedor é PF) como **signatário/avalista**.

1. No modal **Gerar termo de acordo** (`abrirTermoAcordoJ` em `index.html`), botão
   **"🔎 Verificar sócios / empresas"** → `_tajVerificarDoc()`.
2. Cada resultado tem **"+ avalista"** (`_tajAddAvalistaFromSocio` / `_tajAddAvalistaFromEmpresa`),
   que adiciona uma linha em "Outros devedores que assinam".
3. Esse extra entra em `dados.devedores[]`, ganha a âncora **`<<assdevN>>`** no
   `TermoEngine` e vira **um signatário no ZapSign** (mesmo documento, um link por
   signatário) via a edge `gerar-acordo-termo`.
4. **Complete o CPF/telefone reais** do avalista antes de enviar — o QSA vem mascarado
   e o ZapSign exige `require_cpf` válido (11/14 dígitos).

Vale tanto para o termo **extrajudicial** quanto para o **judicial** (o mesmo modal
tem o seletor de tipo).

## Aplicação 2 — AÇÃO JUDICIAL (polo passivo / desconsideração)

> Atuação judicial é da advocacia (**Teixeira & Azzolin**), não da COBRASQ pública.
> Use isto para instruir a petição, não para material público da recuperadora.

Objetivo: quando a empresa devedora não tem patrimônio, identificar os **sócios** para
pedir a **desconsideração da personalidade jurídica** e/ou incluí-los no **polo passivo**.

1. **Devedor PJ:** rode a consulta de sócios; liste nome, qualificação (administrador
   vs. quotista) e a data de entrada. Sócio-**administrador** é o alvo típico do IDPJ.
2. **Devedor PF que esvaziou patrimônio:** rode CPF → empresas para achar empresas onde
   ele é sócio (blindagem patrimonial / confusão patrimonial).
3. Leve para a petição:
   - **Incidente de Desconsideração da Personalidade Jurídica (IDPJ)** — arts. 133–137
     CPC, fundamento material art. 50 CC (desvio de finalidade / confusão patrimonial).
   - **Inclusão no polo passivo** dos sócios identificados (com qualificação completa —
     peça o CPF completo ao cliente/base, pois o QSA é mascarado).
   - Anexe a **fonte e a data** da consulta (situação cadastral, QSA) como prova do vínculo.
4. Ganchos no código/fluxo de petição: edges `gerar-peticao-pdf`, `peticao-assistente`,
   `_eproc-peticionamento` (`api/`). O termo judicial de acordo usa a âncora extra
   `<<assadv2>>` para advogado da parte ré — reutilize a mesma ideia de "parte adicional".

## Cuidados (obrigatório)

- **Finalidade legítima apenas:** cobrança/recuperação de crédito e instrução processual
  de casos reais da carteira. Não é ferramenta de investigação de terceiros sem relação
  com um débito.
- **LGPD:** o dado da RFB é público, mas o CPF vem mascarado — não tente "desmascarar";
  o CPF completo vem do próprio cadastro do devedor/cliente, não da consulta.
- **Confirme pelo miolo** antes de agir; homônimo confirmado por engano vira réu/avalista
  errado. Se `confere !== true`, trate como candidato, não como certeza.
- **Não** anuncie atuação judicial em nome da COBRASQ (privativa de advocacia).

## Referências de código

- `index.html` — `cnpjSociosLookup`, `_tajVerificarDoc`, `_tajRenderSocios`,
  `_tajRenderEmpresasPF`, `_tajAddAvalistaFromSocio`, `_tajAddAvalistaFromEmpresa`.
- `api/_cnpja.js` (ação `cnpja` em `api/automacao.js`) — proxy CPF→empresas, gated.
- `supabase/migrations/2026-07-27_rf_cnpj_socios.sql` — tabelas `rf_*` + RPC
  `buscar_empresas_por_socio`.
- `scripts/import_cnpj_rf.py` — ETL do dump da Receita (`--uf PR`).
- `templates/termo-engine.js` — âncoras `<<assdevN>>` / `<<assadv2>>`.
