// api/_telefone-jid.js — versão CommonJS de supabase/functions/_shared/telefone-jid.ts,
// para o runtime da Vercel. Mantenha as duas em sincronia.
//
// Resolve o JID com que o WhatsApp realmente conhece o número antes de enviar:
// o cadastro guarda o celular COM o nono dígito, mas boa parte dos contatos do
// Sul está registrada SEM ele. Discar o formato errado não dá erro — a Z-API
// aceita, devolve zaapId, o painel marca "enviada" — e a mensagem fica num ✓
// único para sempre. Prefixo `_`: não conta no limite de 12 funções da Vercel.

// Regra por COMPRIMENTO, nunca startsWith('55'): o DDD 55 (região central do RS)
// colide com o código do país.
function comDDI55(telefone) {
  const d = String(telefone == null ? '' : telefone).replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 || d.length === 11 ? '55' + d : d;
}

function ehIdentificadorNaoTelefone(telefone) {
  const bruto = String(telefone == null ? '' : telefone);
  if (bruto.includes('-group')) return true;
  return bruto.replace(/\D/g, '').length > 13;
}

function variantesComEsem9(phone) {
  const v = [phone];
  if (phone.length === 13) v.push(phone.slice(0, 4) + phone.slice(5));
  else if (phone.length === 12) v.push(phone.slice(0, 4) + '9' + phone.slice(4));
  return v;
}

const cache = new Map();

async function consultar(base, headers, variante) {
  try {
    const r = await fetch(`${base}/phone-exists/${variante}`, { headers, signal: AbortSignal.timeout(7000) });
    if (!r.ok) return { existe: false, canonico: null, falhou: true };
    const j = await r.json().catch(() => null);
    if (!j) return { existe: false, canonico: null, falhou: true };
    const existe = typeof j.exists === 'boolean' ? j.exists : (typeof j.isUser === 'boolean' ? j.isUser : false);
    const canonico = existe ? (String(j.outputPhone || '').replace(/\D/g, '') || variante) : null;
    return { existe, canonico };
  } catch {
    return { existe: false, canonico: null, falhou: true };
  }
}

// Retorna { jid, existe, indeterminado, tentativas, mudou }. `indeterminado`
// significa que a Z-API não respondeu — não que o número seja inválido.
async function resolverJid(base, headers, telefone) {
  const alvo = comDDI55(telefone);
  if (!alvo) return { jid: null, existe: false, tentativas: [], mudou: false };
  if (ehIdentificadorNaoTelefone(telefone)) {
    return { jid: String(telefone), existe: true, tentativas: [], mudou: false };
  }
  if (cache.has(alvo)) return Object.assign({}, cache.get(alvo), { doCache: true });

  const tentativas = [];
  let todasFalharam = true;
  for (const v of variantesComEsem9(alvo)) {
    tentativas.push(v);
    const { existe, canonico, falhou } = await consultar(base, headers, v);
    if (!falhou) todasFalharam = false;
    if (existe && canonico) {
      const r = { jid: canonico, existe: true, tentativas, mudou: canonico !== alvo };
      cache.set(alvo, r);
      return r;
    }
  }
  if (todasFalharam) return { jid: alvo, existe: false, indeterminado: true, tentativas, mudou: false };
  const r = { jid: alvo, existe: false, tentativas, mudou: false };
  cache.set(alvo, r);
  return r;
}

// Mesmo assinante? Compara pelos últimos 8 dígitos, que não mudam entre os
// formatos do mesmo número (com/sem nono dígito, com/sem DDI). Distingue "outro
// formato do mesmo telefone" de "telefone trocado".
function mesmoNumero(a, b) {
  const sa = String(a == null ? '' : a).replace(/\D/g, '');
  const sb = String(b == null ? '' : b).replace(/\D/g, '');
  if (sa.length < 8 || sb.length < 8) return false;
  return sa.slice(-8) === sb.slice(-8);
}

module.exports = { comDDI55, ehIdentificadorNaoTelefone, variantesComEsem9, resolverJid, mesmoNumero };
