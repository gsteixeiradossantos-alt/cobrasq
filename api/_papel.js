// api/_papel.js — papel do usuário logado em app_users (service role).
// Usado pelos proxies que o colaborador não pode usar (Asaas, Z-API — decisão do
// Gustavo, 28/09/2026: boleto e WhatsApp ficam desligados para o colaborador).
// Prefixo `_`: não conta no limite de 12 funções da Vercel.

const { sbFetch } = require('./_sb.js');

// Responde 403 ao colaborador e 503 se não conseguir conferir (fail-closed).
// Devolve true quando a requisição pode seguir. Cedente/devedor seguem como antes
// (o portal usa estes proxies em fluxos próprios).
async function bloquearColaborador(user, res, oque) {
  let rows;
  try {
    rows = await sbFetch(`app_users?id=eq.${encodeURIComponent(user.id)}&select=papel`, { method: 'GET' });
  } catch (e) {
    console.error(`[${oque} proxy] leitura de app_users falhou:`, e.message);
    res.status(503).json({ error: 'Não foi possível conferir sua permissão. Tente novamente.' });
    return false;
  }
  const u = Array.isArray(rows) ? rows[0] : null;
  if (u && u.papel === 'colaborador') {
    res.status(403).json({ error: `${oque} não está liberado para o seu usuário. Fale com o Gustavo.` });
    return false;
  }
  return true;
}

module.exports = { bloquearColaborador };
