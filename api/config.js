// api/config.js — Expõe configurações públicas de servidor (sem segredos)
// As variáveis SUPABASE_URL e SUPABASE_ANON_KEY são seguras para expor:
// a chave anon é pública por design; a segurança vem das RLS policies.

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=60');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  res.status(200).json({
    supabaseUrl:     process.env.SUPABASE_URL      || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
};
