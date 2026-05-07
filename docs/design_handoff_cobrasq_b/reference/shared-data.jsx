// Mock data shared by all 3 directions — taken from the real COBRASQ structure

const SHARED = {
  brand: {
    name: 'COBRASQ',
    tagline: 'RECUPERADORA DE CRÉDITO',
  },
  loginFeats: [
    { title: 'Gestão completa de cobranças', desc: 'Devedores, processos e acordos em um só lugar.' },
    { title: 'Fase extrajudicial e judicial', desc: 'Acompanhe cada etapa da recuperação.' },
    { title: 'Comunicação integrada', desc: 'WhatsApp, e-mail e histórico em uma timeline.' },
    { title: 'Indicadores em tempo real', desc: 'Dashboards para decisões estratégicas.' },
  ],
  navItems: [
    { group: 'Principal', items: [
      { id: 'painel', label: 'Painel', active: true },
      { id: 'cobr', label: 'Cobranças' },
      { id: 'clientes', label: 'Clientes' },
      { id: 'docs', label: 'Documentos' },
    ]},
    { group: 'Financeiro', items: [
      { id: 'fin', label: 'Financeiro' },
      { id: 'relat', label: 'Relatórios' },
    ]},
    { group: 'Comunicação', items: [
      { id: 'wa', label: 'WhatsApp' },
    ]},
    { group: 'Sistema', items: [
      { id: 'config', label: 'Configurações' },
    ]},
  ],
  kpis: [
    { label: 'Carteira ativa',         value: 'R$ 8.420.190', delta: '+4,2%', dir: 'up'   },
    { label: 'Recuperado no mês',      value: 'R$ 612.480',   delta: '+18,7%', dir: 'up'  },
    { label: 'Acordos em vigor',       value: '247',          delta: '+12',    dir: 'up'  },
    { label: 'Inadimplência média',    value: '38 dias',      delta: '−3 d',   dir: 'down'},
  ],
  devedores: [
    { nome: 'Rafael Almeida Souza',     doc: '124.580.927-43', credor: 'Banco Atlas',          valor: 'R$ 24.380,00', status: 'Em acordo',     prazo: '12/05', resp: 'M.S.' },
    { nome: 'Construtora Vértice LTDA', doc: '34.812.094/0001-02', credor: 'Fornecedor Aurea', valor: 'R$ 187.940,50', status: 'Negociando',   prazo: '08/05', resp: 'A.L.' },
    { nome: 'Camila Ferreira Lima',     doc: '987.610.214-08', credor: 'Cred Fácil',           valor: 'R$ 5.120,40',  status: 'Judicial',      prazo: '21/05', resp: 'J.P.' },
    { nome: 'Marcelo Tavares',          doc: '442.890.117-92', credor: 'Banco Atlas',          valor: 'R$ 12.760,00', status: 'Pago',          prazo: '—',     resp: 'M.S.' },
    { nome: 'Eduarda Pinheiro Castro',  doc: '610.345.882-71', credor: 'Loja Norte Sul',       valor: 'R$ 1.840,00',  status: 'Notificado',    prazo: '15/05', resp: 'A.L.' },
    { nome: 'Indústrias Cerro S.A.',    doc: '12.485.901/0001-67', credor: 'Fornecedor Aurea', valor: 'R$ 412.300,00', status: 'Em acordo',    prazo: '30/05', resp: 'J.P.' },
    { nome: 'Bruno Kaminski',           doc: '709.214.553-19', credor: 'Cred Fácil',           valor: 'R$ 8.940,00',  status: 'Negociando',    prazo: '10/05', resp: 'M.S.' },
    { nome: 'Alvaro Mendes Restaurante',doc: '24.901.778/0001-44', credor: 'Loja Norte Sul',   valor: 'R$ 3.420,80',  status: 'Notificado',    prazo: '18/05', resp: 'A.L.' },
  ],
  // Sparkline points for chart placeholders
  spark: [22, 28, 26, 34, 31, 38, 42, 39, 47, 51, 49, 58, 62, 60, 68, 72, 70, 78],
  bars:  [42, 58, 49, 71, 64, 82, 76, 88, 71, 92, 85, 96],
};

window.SHARED = SHARED;
