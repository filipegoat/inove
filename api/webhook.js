import crypto from 'crypto';

// ── Anti-replay: guarda IDs de pagamentos já processados ──────────────────
// Em produção use Redis ou banco de dados para persistir entre instâncias
const processedPayments = new Set();

// ── Verifica assinatura do Mercado Pago ───────────────────────────────────
// Documentação: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
function verifyMPSignature(req) {
  const xSignature  = req.headers['x-signature'];
  const xRequestId  = req.headers['x-request-id'];
  const MP_SECRET   = process.env.MP_WEBHOOK_SECRET; // configurado no painel MP

  if (!xSignature || !xRequestId || !MP_SECRET) {
    console.warn('Webhook sem assinatura ou secret não configurado');
    return false;
  }

  // Formato do header: ts=<timestamp>,v1=<hash>
  const parts = {};
  xSignature.split(',').forEach(part => {
    const [k, v] = part.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  });

  if (!parts.ts || !parts.v1) return false;

  // Manifesto conforme doc do MP
  const dataId   = req.body?.data?.id;
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${parts.ts};`;

  const expected = crypto
    .createHmac('sha256', MP_SECRET)
    .update(manifest)
    .digest('hex');

  // timingSafeEqual evita timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(parts.v1,  'utf8')
    );
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  // Webhook não precisa de CORS — só o MP chama esse endpoint
  if (req.method !== 'POST') return res.status(405).end();

  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SMM_API_KEY     = process.env.SMM_API_KEY;

  if (!MP_ACCESS_TOKEN || !SMM_API_KEY) {
    console.error('Variáveis de ambiente não configuradas no webhook');
    return res.status(500).end();
  }

  try {
    // ── 1. Valida assinatura antes de qualquer processamento ──
    if (!verifyMPSignature(req)) {
      console.warn('Webhook rejeitado: assinatura inválida. IP:', req.headers['x-forwarded-for']);
      return res.status(401).end(); // Silencia — não explica o motivo
    }

    const { type, data } = req.body;

    // Só processa notificações de pagamento
    if (type !== 'payment' || !data?.id) {
      return res.status(200).json({ ok: true });
    }

    const paymentId = String(data.id);

    // ── 2. Anti-replay: não processa o mesmo pagamento duas vezes ──
    if (processedPayments.has(paymentId)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    // ── 3. Busca os detalhes do pagamento diretamente no MP ──
    // Nunca confia nos dados do body do webhook — sempre re-valida na API
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!mpRes.ok) {
      console.error('Falha ao buscar pagamento no MP:', paymentId);
      return res.status(200).json({ ok: true }); // Responde 200 para MP não retentar em loop
    }

    const payment = await mpRes.json();

    // ── 4. Só prossegue se o pagamento realmente foi aprovado ──
    if (payment.status !== 'approved') {
      return res.status(200).json({ ok: true, status: payment.status });
    }

    // ── 5. Pega os dados do metadata (gravados pelo create-payment.js) ──
    const { service_id, quantity, profile_link, platform } = payment.metadata || {};

    if (!service_id || !quantity || !profile_link) {
      console.error('Metadata incompleto no pagamento aprovado:', paymentId);
      return res.status(200).json({ ok: true });
    }

    // ── 6. Valida dados do metadata antes de enviar ao SMMKings ──
    const qty = parseInt(quantity);
    if (!qty || qty < 1 || qty > 1000000) {
      console.error('Quantidade inválida no metadata:', quantity, 'pagamento:', paymentId);
      return res.status(200).json({ ok: true });
    }

    // Valida protocolo da URL salva no metadata
    try {
      const parsed = new URL(profile_link);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      console.error('profile_link inválido no metadata do pagamento:', paymentId);
      return res.status(200).json({ ok: true });
    }

    // ── 7. Envia o pedido para o SMMKings ──────────────────────
    const smmRes = await fetch('https://smmkings.com/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        key:      SMM_API_KEY,
        action:   'add',
        service:  service_id,
        link:     profile_link, // vem do metadata salvo, não do frontend
        quantity: qty,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });

    const smmData = await smmRes.json();

    // ── 8. Marca como processado para evitar duplicatas ────────
    processedPayments.add(paymentId);
    setTimeout(() => processedPayments.delete(paymentId), 24 * 60 * 60 * 1000); // limpa em 24h

    if (smmData.error) {
      // Log interno — não expõe ao MP (ele não precisa saber)
      console.error('Erro SMMKings p/ pagamento', paymentId, ':', smmData.error);
    } else {
      console.log('Pedido SMMKings criado:', smmData.order, '| pagamento:', paymentId);
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook erro interno:', err.message);
    return res.status(500).end(); // Não expõe detalhes
  }
}
