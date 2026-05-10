# Geração de Peças Judiciais (Upgrade #17)

Origem: pedido em 10/05/2026 — *"templates de ações com campos editáveis, layout peticao-style, gerar petição inicial + procuração + doc empresa + prova documental + cálculo"*.

## Arquitetura

- **Onde mora:** `crm-cobrasq/index.html` — botão "⚖ Gerar peça judicial" aparece no header do caso quando status = `Encaminhado ao judicial` ou `acao judicial`.
- **Banco:** Supabase `jokbxzhcctcwnbhkhgru` (compartilhado).
- **Storage:** bucket `peticao-assets` (privado, 20 MB/arquivo, MIME PDF/imagem/Office).
- **PDF:** geração browser-side via HTML estilizado (peticao-style) + `window.print()` em janela separada. Sem libs externas.
- **Cálculo:** botão abre `cobrasq-faturamento.vercel.app/calc-juridica.html` com query string pré-preenchendo valor + datas + nome devedor/credor. User salva memorial PDF e anexa de volta.

## Schema (já aplicado)

### `peticao_templates`
Templates editáveis com mail-merge `{{variavel}}`.
```
id, tipo (inicial_cobranca|execucao_extrajudicial|monitoria|busca_apreensao|outros),
nome, descricao, conteudo_html, variaveis JSONB, ativo, created_at, updated_at
```

Cada item de `variaveis` tem:
- `key` — nome do `{{token}}` no HTML
- `label` — exibido na UI
- `tipo` — `text|textarea|date`
- `obrigatorio` — bool
- `auto` — path tipo `cliente.nome`, `devedor.doc`, `divida.valor_original_brl`, `calculo.total_brl`, `hoje_extenso`
- `default`, `placeholder` — opcionais

### `cliente_documentos`
Procurações, contratos sociais, cartões CNPJ por cliente. Reutilizáveis em todas as peças daquele credor.
```
id, cliente_id FK, tipo (procuracao|contrato_social|cartao_cnpj|identidade|outros),
nome, storage_path, mime_type, size_bytes, validade, ativo,
uploaded_by, uploaded_at, obs
```

### `peticao_geradas`
Histórico de peças geradas (auditoria).
```
id, devedor_id FK, template_id, template_tipo, dados_preenchidos JSONB,
anexos JSONB (lista de docs anexados), pdf_storage_path, status,
protocolo_num, protocolada_em, owner_id, created_at, updated_at
```

### Storage `peticao-assets`
- Path: `{auth.uid}/clientes/{cliente_id}/{tipo}/{timestamp}_{filename}`
- Path provas: `{auth.uid}/devedores/{devedor_id}/provas/{timestamp}_{filename}`
- RLS: usuário só lê/escreve seus próprios paths (folder = auth.uid().)

## Templates seedados (3)

1. **Petição Inicial — Cobrança** (CPC art. 319/320/322)
2. **Execução de Título Extrajudicial** (CPC art. 783/784/824)
3. **Ação Monitória** (CPC art. 700+)

Cada um segue **peticao-style Teixeira Advogados**:
- Palatino Linotype 12pt, justificado, entrelinhas 1.4
- Sem recuo de primeira linha
- Títulos em versalete (small-caps)
- Subtítulos com travessão (—) + itálico+negrito
- Endereçamento em 13pt itálico, processo em 10pt
- Rodapé Teixeira Advogados na 1ª página
- Cabeçalho "TEIXEIRA *Advogados*" + linha dourada (#B8924B)

## UI no CRM (4 etapas)

1. **Selecionar template** — radio list dos templates ativos
2. **Preencher campos** — form gerado a partir das `variaveis` do template; campos com `auto` aparecem com tag `(auto)` em verde mas são editáveis
3. **Anexos**:
   - Documentos do cliente (procuração/contrato social/cartão CNPJ) — listados por cliente, baixáveis
   - Provas documentais da dívida — upload local da sessão (não persiste por padrão, pode ser anexado ao PDF final no futuro)
   - Memorial de cálculo — botão "Abrir Calculadora pré-preenchida" + opção de anexar PDF gerado
4. **Pré-visualização + Imprimir/Salvar PDF** — abre janela com layout peticao-style; user usa diálogo de impressão do navegador pra salvar PDF

## Mail-merge — paths `auto` suportados

| Path | Resolve para |
|---|---|
| `cliente.nome` | `caso.credor` |
| `cliente.doc` | `caso.credor_doc` |
| `cliente.endereco_completo` | `caso.credor_endereco` |
| `devedor.nome` | `caso.devedor` |
| `devedor.doc` | `caso.documento` |
| `devedor.endereco_completo` | `caso.endereco` |
| `divida.valor_original_brl` | `fmtBRL(caso.divida.valorOriginal)` |
| `calculo.total_brl` | `fmtBRL(peca.anexos.calculoTotal)` (preenchido após anexar PDF) |
| `hoje_extenso` | "10 de maio de 2026" |

## Futuro

- **Concatenação automática do PDF final** (petição + anexos) via `pdf-lib.js` browser-side
- **Editor visual** dos templates (Configurações → Templates) — hoje só via SQL
- **Templates adicionais**: busca e apreensão (Decreto-Lei 911), embargos, contestação, embargos à execução
- **Assinatura digital** integrada (similar ao ZapSign já usado pra acordos)
- **Sync com Astrea** — ao gerar peça, registrar automaticamente no Astrea via API
