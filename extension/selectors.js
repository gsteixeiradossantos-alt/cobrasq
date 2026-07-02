// extension/selectors.js — Seletores do eproc TJPR.
//
// Calibrado a partir dos manuais oficiais "Eproc para Advogado" (Distribuição de
// Inicial, Painel do Advogado, Primeiros Passos — TJPR, out/2025). Os manuais dão
// os RÓTULOS e TEXTOS DE BOTÃO reais e o fluxo; os ids/names exatos do DOM ainda
// podem variar por versão/grau, então cada campo tem (1) uma lista de candidatos
// CSS e (2) um vocabulário de rótulos/textos para o fallback em content-eproc.js
// (byLabel / acharBotao). Ajuste rápido aqui, sem mexer na lógica.
//
// Fluxos cobertos:
//  • INICIAL / Distribuição — assistente de 5 etapas (Informações do processo →
//    Assuntos → Partes requerentes → Partes requeridos → Documentos), botão de
//    avanço "Próxima" e botão final "Finalizar".
//  • INTERCORRENTE — juntar petição/documento a um processo existente: seleciona
//    "Tipo de Documento", anexa o PDF e finaliza em "Peticionar"/"Confirmar".
//
// Como refinar com o DOM real: no eproc logado, F12 → inspecione o select/input/
// botão e cole o melhor seletor nas listas abaixo.

window.EPROC_SEL = {
  // Container/Formulário da tela de peticionamento (best-effort; usado só p/ detecção).
  paginaPeticionar: [
    'form[action*="peticao" i]',
    'form[action*="processo" i]',
    'form[name*="frm" i]',
    '#divInfraAreaTela',
  ],
  // Select do "Tipo de Documento" / "Tipo de Petição" / evento.
  tipoDocumento: [
    'select[name*="tipoDocumento" i]',
    'select[id*="tipoDocumento" i]',
    'select[name*="tipoPeticao" i]',
    'select[id*="tipoPeticao" i]',
    'select[name*="evento" i]',
    'select[name*="tipo" i]',
  ],
  // Select da parte / polo (Tipo Pessoa, requerente/requerido/executado).
  parte: [
    'select[name*="tipoPessoa" i]',
    'select[name*="parte" i]',
    'select[name*="polo" i]',
  ],
  // Input file para anexar o PDF.
  anexoPdf: [
    'input[type="file"]',
    'input[name*="anexo" i]',
    'input[name*="arquivo" i]',
    'input[name*="documento" i]',
  ],
  // Botão de AVANÇAR etapa do wizard (inicial: "Próxima"). NÃO é o protocolo.
  botaoAvancar: [
    'input[type="submit"][value*="Próxima" i]',
    'input[type="button"][value*="Próxima" i]',
    'input[value*="Próximo" i]',
    'input[value*="Avançar" i]',
    'button[name*="proxima" i]',
  ],
  // Botão FINAL de protocolo/distribuição (NUNCA clicado automaticamente por padrão).
  //  • inicial: "Finalizar"  • intercorrente: "Peticionar"/"Confirmar"  • legado: "Protocolar".
  botaoFinal: [
    'input[type="submit"][value*="Finalizar" i]',
    'input[value*="Finalizar" i]',
    'input[value*="Peticionar" i]',
    'input[value*="Protocolar" i]',
    'input[value*="Confirmar" i]',
    'input[value*="Assinar" i]',
    'button[name*="finalizar" i]',
    'button[name*="peticionar" i]',
  ],
  // Onde o eproc mostra o número do protocolo após enviar (best-effort; se não
  // acharmos, o humano cola o número no painel).
  resultadoProtocolo: [
    '#numeroProtocolo',
    '.protocolo',
    '#txtNumProcesso',
  ],
};

// Vocabulário de RÓTULOS/TEXTOS reais (minúsculas, sem exigir acento perfeito) usado
// pelo fallback por rótulo em content-eproc.js quando os seletores CSS falham.
window.EPROC_TXT = {
  tipoDocumento: ['tipo de documento', 'tipo do documento', 'tipo de petição', 'tipo de peticao', 'evento', 'tipo de evento'],
  parte: ['tipo pessoa', 'parte', 'polo', 'requerente', 'requerido', 'executado'],
  anexo: ['anexar documento', 'adicionar documento', 'adicionar arquivo', 'escolher arquivo', 'procurar', 'anexar', 'arquivo'],
  avancar: ['próxima', 'proxima', 'próximo', 'proximo', 'avançar', 'avancar', 'continuar'],
  final: ['finalizar', 'peticionar', 'protocolar', 'confirmar', 'assinar', 'distribuir'],
};

// Vocabulário por CAMPO do assistente de distribuição (inicial, 5 etapas). Usado
// pelo motor multi-etapas (content-eproc.js) via byAnyLabel — calibrado com a tela
// real do eproc TJPR ("Peticionamento Eletrônico (1 de 5) - Informações do processo").
window.EPROC_DIST = {
  // Etapa 1 — Informações do processo. No eproc TJPR o campo da comarca é o select
  // "Desejo entrar com a ação em:" (não diz "Comarca").
  comarca: ['desejo entrar com a ação em', 'desejo entrar com a acao em', 'entrar com a ação', 'entrar com a acao', 'comarca', 'foro', 'seção judiciária', 'secao judiciaria'],
  valorCausa: ['valor da causa', 'valor da ação', 'valor da acao', 'valor da demanda', 'valor'],
  rito: ['rito', 'procedimento'],
  area: ['área', 'area'],
  classe: ['classe processual', 'classe'],
  sigilo: ['nível de sigilo', 'nivel de sigilo', 'sigilo'],
  // Etapa 2 — Assuntos
  assuntoBusca: ['pesquisar assunto', 'filtrar assunto', 'assunto'],
  filtrar: ['filtrar', 'pesquisar', 'buscar'],
  // Etapas 3/4 — Partes
  tipoPessoa: ['tipo pessoa', 'tipo de pessoa'],
  docParte: ['cpf/cnpj', 'cpf / cnpj', 'cnpj', 'cpf', 'documento'],
  nomeParte: ['nome', 'razão social', 'razao social'],
  consultar: ['consultar', 'pesquisar'],
  salvar: ['salvar'],
  incluir: ['incluir', 'adicionar'],
};
