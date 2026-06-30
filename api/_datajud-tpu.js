// api/_datajud-tpu.js — Curadoria dos movimentos processuais do DataJud/CNJ.
//
// A timeline do caso (no CRM e no portal do cedente) NÃO mostra o despejo cru do
// CNJ — ela mostra só os atos RELEVANTES, com rótulos amigáveis em PT-BR. Esta
// camada é a fonte única dessa decisão: o cron (api/cron-datajud.js) e a migração
// de backfill usam `curarMovimento()` para decidir o que entra e com que nome.
//
// Modelo: whitelist por código TPU/CNJ. Código fora da tabela → cai no fallback
// por substring do nome; se nem isso casar, é descartado (include:false). Assim,
// ruído novo do tribunal não polui a timeline por padrão.
//
// Espelhado no front (const TPU_MOV no index.html) para relabel de resíduos
// legados em metadata.historico. Mantenha os dois em sincronia ao editar.

// codigo → { include, label }. Rótulos com {situacao}/{resultado} são enriquecidos
// pelo complemento tabelado do movimento (ver enriquecer()).
const TPU_MOV = {
  26:    { include: true,  label: 'Ação distribuída (protocolada)' },
  85:    { include: true,  label: 'Petição protocolada' },
  12740: { include: true,  label: 'Audiência de conciliação{situacao}' },
  106:   { include: true,  label: 'Mandado{resultado}' },
  848:   { include: true,  label: 'Trânsito em julgado' },
  246:   { include: true,  label: 'Arquivamento definitivo' },
  193:   { include: true,  label: 'Sentença proferida' },
  219:   { include: true,  label: 'Sentença de procedência' },
  220:   { include: true,  label: 'Sentença de improcedência' },
  3:     { include: true,  label: 'Decisão proferida' },
  11009: { include: true,  label: 'Despacho do juízo' },
  51:    { include: true,  label: 'Penhora/constrição de bens' },
  970:   { include: true,  label: 'Processo arquivado' },
  466:   { include: true,  label: 'Processo suspenso' },
  // Ruído procedural — explicitamente descartado.
  123:   { include: false, label: 'Remessa' },
  132:   { include: false, label: 'Recebimento' },
  581:   { include: false, label: 'Documento' },
  60:    { include: false, label: 'Expedição de documento' },
  14736: { include: false, label: 'Inclusão no Juízo 100% Digital' },
  12266: { include: false, label: 'Confirmada' },
  12283: { include: false, label: 'Confirmada' },
  12293: { include: false, label: 'Ato cumprido pela parte ou interessado' },
  11383: { include: false, label: 'Ato ordinatório' },
};

// Fallback por substring do NOME (quando o código é desconhecido). Ordem importa:
// o primeiro casamento vence. Só inclui atos que valham aparecer ao cliente.
const NOME_FALLBACK = [
  { re: /tr[âa]nsito em julgado/i, label: 'Trânsito em julgado' },
  { re: /senten[çc]a/i,            label: 'Sentença proferida' },
  { re: /penhora|constri[çc][ãa]o|arresto|bacenjud|sisbajud/i, label: 'Penhora/constrição de bens' },
  { re: /audi[êe]ncia/i,           label: 'Audiência{situacao}' },
  { re: /despacho/i,               label: 'Despacho do juízo' },
  { re: /decis[ãa]o/i,             label: 'Decisão proferida' },
  { re: /distribui[çc][ãa]o/i,     label: 'Ação distribuída (protocolada)' },
  { re: /arquivamento/i,           label: 'Processo arquivado' },
  { re: /senten[çc]a|proced[êe]ncia/i, label: 'Sentença proferida' },
];

// Extrai o VALOR humano do complemento tabelado (ex.: audiência "realizada"/
// "designada"; mandado "entregue ao destinatário"). No DataJud cada complemento é
// { codigo, valor, nome, descricao } onde `nome` é o valor legível e `descricao` é
// o TIPO do campo (ex.: "situacao_da_audiencia", "resultado"). Preferimos o
// complemento cujo TIPO é situação/resultado e devolvemos seu `nome`.
function complementoTexto(complementos) {
  if (!Array.isArray(complementos)) return '';
  const rel = complementos.find(
    (c) => c && c.nome && /situa[çc][ãa]o|resultado/i.test(String(c.descricao || ''))
  );
  if (rel) return String(rel.nome);
  const first = complementos.find((c) => c && c.nome);
  return first ? String(first.nome) : '';
}

// Aplica os placeholders {situacao}/{resultado} do rótulo usando o complemento.
function enriquecer(label, complementos) {
  if (!/\{situacao\}|\{resultado\}/.test(label)) return label;
  const txt = complementoTexto(complementos);
  const suf = txt ? ' — ' + txt.charAt(0).toLowerCase() + txt.slice(1) : '';
  return label.replace(/\{situacao\}|\{resultado\}/g, suf);
}

// Decide e nomeia um movimento. Retorna { include, label }.
function curarMovimento(codigo, nome, complementos) {
  const cod = codigo != null ? String(codigo) : '';
  const hit = TPU_MOV[cod];
  if (hit) {
    return { include: !!hit.include, label: enriquecer(hit.label, complementos) };
  }
  for (const f of NOME_FALLBACK) {
    if (f.re.test(String(nome || ''))) {
      return { include: true, label: enriquecer(f.label, complementos) };
    }
  }
  return { include: false, label: String(nome || 'Movimentação') };
}

module.exports = { TPU_MOV, curarMovimento, enriquecer, complementoTexto };
