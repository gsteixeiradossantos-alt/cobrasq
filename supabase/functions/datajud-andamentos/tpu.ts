// datajud-andamentos/tpu.ts — Curadoria dos movimentos processuais do DataJud/CNJ.
//
// Cópia em TypeScript de api/_datajud-tpu.js (mesma tabela, mesma lógica), para a
// Edge Function datajud-andamentos. Há também o espelho TPU_MOV no index.html.
// Mantenha os TRÊS em sincronia ao editar.

type Regra = { include: boolean; label: string };

export const TPU_MOV: Record<string, Regra> = {
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
  51:    { include: true,  label: 'Conclusos' },
  970:   { include: true,  label: 'Processo arquivado' },
  466:   { include: true,  label: 'Acordo homologado' },
  893:   { include: true,  label: 'Processo desarquivado' },
  898:   { include: true,  label: 'Processo suspenso por decisão judicial' },
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

const NOME_FALLBACK: { re: RegExp; label: string }[] = [
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

export function complementoTexto(complementos: unknown): string {
  if (!Array.isArray(complementos)) return '';
  const rel = complementos.find(
    (c: any) => c && c.nome && /situa[çc][ãa]o|resultado/i.test(String(c.descricao || '')),
  );
  if (rel) return String((rel as any).nome);
  const first = complementos.find((c: any) => c && c.nome);
  return first ? String((first as any).nome) : '';
}

export function enriquecer(label: string, complementos: unknown): string {
  if (!/\{situacao\}|\{resultado\}/.test(label)) return label;
  const txt = complementoTexto(complementos);
  const suf = txt ? ' — ' + txt.charAt(0).toLowerCase() + txt.slice(1) : '';
  return label.replace(/\{situacao\}|\{resultado\}/g, suf);
}

export function curarMovimento(codigo: unknown, nome: unknown, complementos: unknown): Regra {
  const cod = codigo != null ? String(codigo) : '';
  const hit = TPU_MOV[cod];
  if (hit) return { include: !!hit.include, label: enriquecer(hit.label, complementos) };
  for (const f of NOME_FALLBACK) {
    if (f.re.test(String(nome || ''))) return { include: true, label: enriquecer(f.label, complementos) };
  }
  return { include: false, label: String(nome || 'Movimentação') };
}
