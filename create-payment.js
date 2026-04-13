export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

  try {
    const { service_id, service_name, quantity, price, buyer_email, platform } = req.body;

    console.log('Body recebido:', { service_id, service_name, quantity, price, buyer_email, platform });

    // Validar e converter o valor
    const amount = parseFloat(parseFloat(price).toFixed(2));
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Preço inválido', price_recebido: price });
    }

    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': `${Date.now()}-${service_id}-${quantity}`,
      },
      body: JSON.stringify({
        transaction_amount: amount,
        description: `${service_name} - ${quantity} unidades (${platform})`,
        payment_method_id: 'pix',
        payer: {
          email: buyer_email || 'cliente@inove.com.br',
        },
        notification_url: `https://${req.headers.host}/api/webhook`,
        metadata: {
          service_id,
          service_name,
          quantity,
          platform,
        },
      }),
    });

    const payment = await mpResponse.json();
    console.log('Resposta MP status:', payment.status);

    if (!mpResponse.ok) {
      return res.status(400).json({ error: 'Erro ao criar pagamento', details: payment });
    }

    return res.status(200).json({
      payment_id: payment.id,
      status: payment.status,
      qr_code: payment.point_of_interaction?.transaction_data?.qr_code,
      qr_code_base64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
      expires_at: payment.date_of_expiration,
    });

  } catch (err) {
    console.error('Erro interno:', err);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
}
