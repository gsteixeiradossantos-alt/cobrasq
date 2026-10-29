// Número de teste (whatsapp_bia_config.teste_telefone) nunca fica travado: é o
// celular do Gustavo testando a Bia. Nem a trava "humano atendendo" (humano_ate,
// religada a cada envio automático) nem o 'aguardando_humano' param a Bia nele.
// Decisão dele em 29/10/2026 ("destrava eu de novo, permanentemente"); a regra
// das 24h continua valendo para todos os outros números.
//
// Casa pelos últimos 8 dígitos, como a fila do modo teste: cobre o número com e
// sem o 9 e com ou sem o 55.
export function ehNumeroTeste(telefone: unknown, testeTelefone: unknown): boolean {
  const t = String(testeTelefone ?? '').replace(/\D/g, '');
  const n = String(telefone ?? '').replace(/\D/g, '');
  return t.length >= 8 && n.length >= 8 && n.slice(-8) === t.slice(-8);
}
