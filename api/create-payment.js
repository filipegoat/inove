import crypto from 'crypto';

export default async function handler(req, res) {
  // CORS restrito ao seu domínio
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SMM_API_KEY     = process.env.SMM_API_KEY;

  if (!MP_ACCESS_TOKEN || !SMM_API_KEY) {
    console.error('Variáveis de ambiente não configuradas');
    return res.status(500).json({ error: 'Configuração interna inválida' });
  }

  try {
    // ── 1. Recebe dados do frontend ─────────────────────────
    // NUNCA confiamos em price, rate ou service_name vindos do frontend
    const { service_id, quantity, pay_method, profile_link, buyer_email, platform, extras } = req.body;

    // ── 2. Validação rigorosa de entradas ───────────────────
    if (!service_id || typeof service_id !== 'string' || !/^[a-zA-Z0-9_-]{1,20}$/.test(service_id)) {
      return res.status(400).json({ error: 'Serviço inválido' });
    }

    const qty = parseInt(quantity);
    if (!qty || isNaN(qty) || qty < 1 || qty > 1000000) {
      return res.status(400).json({ error: 'Quantidade inválida' });
    }

    if (!profile_link || typeof profile_link !== 'string' || profile_link.length > 500) {
      return res.status(400).json({ error: 'Link de perfil inválido' });
    }

    // Valida protocolo da URL — bloqueia javascript:, data:, file:, etc.
    try {
      const parsed = new URL(profile_link);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Link de perfil inválido' });
    }

    const safePlatform = typeof platform === 'string'
      ? platform.replace(/[^a-z]/g, '').slice(0, 20)
      : 'unknown';

    const safeEmail = buyer_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer_email)
      ? buyer_email.slice(0, 200)
      : 'cliente@inove.com.br';

    // ── 3. Busca serviços no SMMKings para calcular preço real ──
    // NUNCA usamos o preço enviado pelo frontend
    const smmRes = await fetch('https://smmkings.com/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: SMM_API_KEY, action: 'services' }).toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!smmRes.ok) return res.status(502).json({ error: 'Provedor indisponível. Tente novamente.' });

    const services = await smmRes.json();
    const service  = services.find(s => String(s.service) === String(service_id));

    if (!service) return res.status(400).json({ error: 'Serviço não encontrado' });

    // Valida min/max do serviço
    const sMin = parseInt(service.min) || 1;
    const sMax = parseInt(service.max) || 1000000;
    if (qty < sMin || qty > sMax) {
      return res.status(400).json({ error: `Quantidade fora do limite permitido (${sMin}–${sMax})` });
    }

    // ── 4. Calcula preço no backend ─────────────────────────
    const MARKUP       = 5.80 * 2.5;
    const PIX_DISCOUNT = 0.95;
    const rate         = parseFloat(service.rate);
    let   amount       = (rate / 1000) * qty * MARKUP;
    if (pay_method === 'pix') amount *= PIX_DISCOUNT;
    amount = Math.max(1.00, Math.round(amount * 100) / 100);

    // ── 5. Calcula extras com rate real do backend ──────────
    let extrasAmount = 0;
    if (Array.isArray(extras) && extras.length <= 10) {
      for (const ex of extras) {
        if (!ex.service_id || !ex.quantity) continue;
        const extService = services.find(s => String(s.service) === String(ex.service_id));
        if (!extService) continue;
        const extQty = Math.max(
          parseInt(extService.min) || 1,
          Math.min(parseInt(extService.max) || 1000000, parseInt(ex.quantity) || 0)
        );
        extrasAmount += (parseFloat(extService.rate) / 1000) * extQty * MARKUP;
      }
    }

    const totalAmount = Math.max(1.00, Math.round((amount + extrasAmount) * 100) / 100);

    // ── 6. Idempotency key criptograficamente segura ────────
    const idempotencyKey = crypto.randomUUID();

    // ── 7. Cria pagamento no Mercado Pago ───────────────────
    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'Authorization':   `Bearer ${MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        transaction_amount: totalAmount,
        description: `${service.name.slice(0, 60)} - ${qty} unidades`,
        payment_method_id: 'pix',
        payer: { email: safeEmail },
        notification_url: `https://${req.headers.host}/api/webhook`,
        metadata: {
          service_id:      String(service_id),
          service_name:    service.name,
          quantity:        qty,
          platform:        safePlatform,
          profile_link,                       // salvo no metadata para o webhook usar
          idempotency_key: idempotencyKey,    // para rastrear e evitar duplicatas
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    const payment = await mpResponse.json();

    if (!mpResponse.ok) {
      // Log interno mas nunca expõe detalhes do MP ao cliente
      console.error('Erro MP:', payment.status, payment.error);
      return res.status(400).json({ error: 'Erro ao criar pagamento. Tente novamente.' });
    }

    return res.status(200).json({
      payment_id:     payment.id,
      status:         payment.status,
      qr_code:        payment.point_of_interaction?.transaction_data?.qr_code,
      qr_code_base64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
      expires_at:     payment.date_of_expiration,
    });

  } catch (err) {
    // Log interno — nunca expõe stack trace ao cliente
    console.error('Erro interno create-payment:', err.message);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
