// extension/selectors.js — Seletores do eproc TJPR (PONTO FRÁGIL).
//
// ⚠️ ATENÇÃO: estes seletores precisam ser VALIDADOS contra o eproc TJPR real
// (logado, inspecionando o DOM). O eproc é formulário web tradicional e o HTML
// varia por versão/grau. Mantemos tudo isolado aqui para ajuste rápido sem mexer
// na lógica. Cada campo tem uma LISTA de candidatos (tenta em ordem) + um fallback
// por rótulo/texto em content-eproc.js.
//
// Como descobrir: no eproc, abra a tela "Movimentar/Peticionar", F12 → inspecione
// o input/select/botão e cole aqui o melhor seletor.

window.EPROC_SEL = {
  // Tela de peticionamento intercorrente / inicial
  paginaPeticionar: [
    'form[name="frmConsultaProcesso"]',
    '#frmConsultaProcesso',
    'form[action*="peticao"]',
  ],
  // Select do "Tipo de petição" / evento
  tipoPeticao: [
    'select[name*="tipo"]',
    'select[name*="evento"]',
    'select#selTipoPeticao',
  ],
  // Select/da parte representada
  parte: [
    'select[name*="parte"]',
    'select[name*="polo"]',
  ],
  // Input file para anexar o PDF
  anexoPdf: [
    'input[type="file"]',
    'input[name*="anexo"]',
    'input[name*="documento"]',
  ],
  // Botão final de protocolo (NUNCA é clicado automaticamente por padrão)
  botaoProtocolar: [
    'input[type="submit"][value*="Protocolar"]',
    'button[name*="protocolar"]',
    'input[value*="Peticionar"]',
    'button:has(span)',
  ],
  // Onde o eproc mostra o número do protocolo após enviar (best-effort; se não
  // acharmos, o humano cola o número no painel).
  resultadoProtocolo: [
    '.protocolo',
    '#numeroProtocolo',
    'td:contains("protocolo")',
  ],
};
