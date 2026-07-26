# Base de conhecimento da Bia

Este diretório é a fonte editável (versionada no git) da base de conhecimento
da Bia, o agente de cobrança no WhatsApp da COBRASQ. Ela é espelhada na tabela
`bia_conhecimento` do Supabase, que é o que a função `bia-atendimento` lê de
fato em produção.

## Como funciona

1. Edite os arquivos `.md` aqui (regras, respostas, glossário, erros).
2. Rode `npm run sync:bia` (ou `node --env-file=.env.local scripts/sync-bia-knowledge.js`)
   pra sincronizar com o Supabase.
3. Só a categoria `regra_negocio` é injetada no prompt (`BIA_SYSTEM`) que a
   função `bia-atendimento` manda pro Claude — é a única categoria que muda o
   comportamento da Bia. As outras (`resposta_modelo`, `glossario`,
   `erro_conhecido`) são referência para humanos e para o Claude Code em
   sessões futuras, não vão pro prompt.
4. Editar o markdown e rodar o sync **não precisa de deploy** — a mudança
   pega no próximo ciclo do cron (a cada ~1 min). Só mudanças de código em
   `bia-atendimento/index.ts` (ex.: como a Bia lê/injeta o conhecimento)
   exigem redeploy da function.

## Formato dos arquivos

Cada entrada é uma seção `## Título` seguida de uma linha de metadados em
comentário HTML (invisível quando o markdown é renderizado no GitHub):

```markdown
## Título da entrada
<!-- slug: identificador-unico | categoria: regra_negocio | ordem: 10 -->

Conteúdo da entrada em texto livre.
```

- `slug`: identificador único (chave primária na tabela). Minúsculo, com
  hífen, sem espaço.
- `categoria`: uma de `regra_negocio`, `resposta_modelo`, `glossario`,
  `erro_conhecido`.
- `ordem` (opcional, padrão 100): controla a ordem de exibição/injeção
  dentro da categoria — menor primeiro.

Remover uma entrada do markdown e rodar o sync marca a linha correspondente
como `ativo = false` no banco (soft-delete — não some do histórico).

## Arquivos

- `regras-negocio.md` — regras que afetam a conversa da Bia (injetadas no prompt).
- `respostas-modelo.md` — textos-base para respostas manuais (fora do fluxo automático).
- `glossario.md` — termos e tabelas do sistema, pra quem for mexer no código.
- `erros-conhecidos.md` — bugs não-óbvios já resolvidos e protocolos operacionais.
