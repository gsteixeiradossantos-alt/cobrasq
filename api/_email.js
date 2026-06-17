// api/_email.js — Envio de e-mail via Resend (runtime Vercel). Canal da régua e das
// notificações pessoais. Requer RESEND_API_KEY; remetente em EMAIL_FROM
// (ex.: "Cobrasq <nao-responda@seu-dominio.com.br>"). emailDisponivel() permite à
// régua pular o canal sem reivindicar envio quando não há provedor configurado.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Cobrasq <nao-responda@cobrasq.com.br>';

function emailDisponivel() { return !!RESEND_API_KEY; }

async function sendEmail({ to, subject, text, html }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY não configurada');
  if (!to) throw new Error('destinatário (to) ausente');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject: subject || 'Cobrasq', text: text || undefined, html: html || undefined }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Resend ' + (data?.message || data?.name || r.status));
  return data;
}

module.exports = { sendEmail, emailDisponivel, EMAIL_FROM };
