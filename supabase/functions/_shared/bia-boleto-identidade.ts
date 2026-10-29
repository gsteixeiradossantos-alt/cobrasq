// Confirmação de identidade antes de a Bia mandar boleto (decisão do Gustavo em 29/10/2026).
//
// Telefone bateu com um cadastro no Asaas: a Bia diz de quem é o cadastro e pede os
// 3 primeiros dígitos do CPF/CNPJ; só manda o boleto se baterem. Se a pessoa disser
// que não confere, errar os dígitos ou o telefone não achar ninguém, a Bia pede o
// CPF/CNPJ completo e o nome completo e procura por eles, inclusive entre homônimos.
//
// Aqui fica só a parte sem rede (textos, leitura da resposta, agrupamento), para teste.

export type ClienteAsaas = { id: string; name: string; cpfCnpj: string };

// Estados gravados em whatsapp_atendimentos.intencao enquanto a Bia espera resposta.
export const ESPERA_DIGITOS = 'boleto_confirmar';
export const ESPERA_DOC = 'boleto_pedir_doc';

// Confirmação vale por 24h: depois disso, novo pedido de boleto confirma de novo.
export const CONFIRMACAO_VALIDADE_MS = 24 * 60 * 60 * 1000;

export const soDigitos = (s: unknown): string => String(s ?? '').replace(/\D/g, '');

export function msgConfirmarCadastro(nome: string): string {
  return `Vi que seu número está vinculado ao cadastro de ${nome}. Confere? Se sim, me envia os 3 primeiros dígitos do seu CPF ou CNPJ.`;
}
// Pessoa física: só o primeiro nome (revela menos se o número mudou de dono; decisão
// do Gustavo em 29/10/2026). Empresa (CNPJ): a razão social inteira, porque o primeiro
// termo ("Mercado", "Comercial") não identifica ninguém.
export function nomeParaConfirmar(nome: string, doc: string): string {
  const n = String(nome || '').trim();
  return soDigitos(doc).length === 14 ? n : n.split(/\s+/)[0] || n;
}
export const MSG_PEDIR_DIGITOS = 'Pra eu confirmar, me envia os 3 primeiros dígitos do seu CPF ou CNPJ.';
export const MSG_PEDIR_DOC = 'Sem problemas! Me envia seu CPF ou CNPJ e seu nome completo, pra eu localizar seu cadastro.';
export const MSG_PEDIR_DOC_NAO_ACHOU = 'Não localizei pelo seu número aqui. Me envia seu CPF ou CNPJ e seu nome completo, pra eu localizar seu cadastro.';
export const MSG_DOC_INVALIDO = 'Não consegui ler o documento. Me envia o CPF (11 números) ou o CNPJ (14 números) e seu nome completo, por favor.';

// Clientes do Asaas com o mesmo CPF/CNPJ são a mesma pessoa (o Asaas aceita cadastro
// duplicado). Agrupa por documento; cliente sem documento fica de fora.
export function agruparPorDoc(clientes: ClienteAsaas[]): { doc: string; nome: string; ids: string[] }[] {
  const m = new Map<string, { doc: string; nome: string; ids: string[] }>();
  for (const c of clientes) {
    const doc = soDigitos(c.cpfCnpj);
    if (!doc) continue;
    const g = m.get(doc) || { doc, nome: String(c.name || '').trim(), ids: [] };
    if (!g.ids.includes(c.id)) g.ids.push(c.id);
    if (!g.nome) g.nome = String(c.name || '').trim();
    m.set(doc, g);
  }
  return [...m.values()];
}

// Resposta ao "Confere?": nega, manda dígitos, ou nenhum dos dois.
export function lerRespostaConfirmacao(texto: string): { tipo: 'nega' } | { tipo: 'digitos'; digitos: string } | { tipo: 'outro' } {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const dig = soDigitos(t);
  if (dig.length >= 3) return { tipo: 'digitos', digitos: dig };
  if (/\b(nao|n|nop|nope|errado|errada|incorreto|nao e|nao sou|outra pessoa|nao confere)\b/.test(t)) return { tipo: 'nega' };
  return { tipo: 'outro' };
}

export function digitosConferem(digitosEnviados: string, docCadastro: string): boolean {
  const d = soDigitos(digitosEnviados), doc = soDigitos(docCadastro);
  return d.length >= 3 && doc.length >= 3 && d.slice(0, 3) === doc.slice(0, 3);
}

// Mensagem com CPF/CNPJ + nome completo. O documento é a primeira sequência com
// 11 ou 14 dígitos (aceita pontos, traços e barra); o nome é o resto do texto.
export function lerDocENome(texto: string): { doc: string; nome: string } {
  const s = String(texto || '');
  let doc = '';
  const re = /\d[\d.\-\/\s]{9,20}\d/g;
  let m: RegExpExecArray | null;
  let resto = s;
  while ((m = re.exec(s))) {
    const d = soDigitos(m[0]);
    if (d.length === 11 || d.length === 14) { doc = d; resto = s.replace(m[0], ' '); break; }
  }
  // Palavras de apresentação ("meu nome é", "cpf", "segue") saem; "da/de/dos" no meio do nome ficam.
  const RUIDO = new Set(['meu', 'minha', 'nome', 'completo', 'cpf', 'cnpj', 'e', 'é', 'sou', 'eu', 'segue', 'aqui', 'o', 'ola', 'olá', 'oi', 'bom', 'dia', 'boa', 'tarde', 'noite']);
  const palavras = resto.replace(/[^A-Za-zÀ-ÿ'\s]/g, ' ').split(/\s+/).filter(Boolean);
  while (palavras.length && RUIDO.has(palavras[0].toLowerCase())) palavras.shift();
  while (palavras.length && RUIDO.has(palavras[palavras.length - 1].toLowerCase())) palavras.pop();
  const nome = palavras.filter((p) => !['cpf', 'cnpj'].includes(p.toLowerCase())).join(' ');
  return { doc, nome };
}

// Compara nomes sem acento e sem caixa.
export const normNome = (s: string): string =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Busca por nome devolve homônimos: fica só quem tem o mesmo documento informado.
export function homonimosComDoc(clientes: ClienteAsaas[], doc: string): ClienteAsaas[] {
  const d = soDigitos(doc);
  return clientes.filter((c) => soDigitos(c.cpfCnpj) === d);
}

export function confirmacaoValida(conf: any, agora = Date.now()): boolean {
  if (!conf || !Array.isArray(conf.ids) || !conf.ids.length || !conf.em) return false;
  const t = new Date(conf.em).getTime();
  return Number.isFinite(t) && agora - t < CONFIRMACAO_VALIDADE_MS;
}
