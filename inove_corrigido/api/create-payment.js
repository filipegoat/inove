export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

  try {
    const { service_id, service_name, quantity, price, buyer_email, platform } = req.body;

    // 1. Cria o pagamento Pix no Mercado Pago
    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': `${Date.now()}-${service_id}-${quantity}`,
      },
      body: JSON.stringify({
        transaction_amount: parseFloat(price),
        description: `${service_name} - ${quantity} unidades (${platform})`,
        payment_method_id: 'pix',
        payer: {
          email: buyer_email || 'cliente@followboost.com.br',
        },
        notification_url: 'https://SEU-PROJETO.vercel.app/api/webhook',
        metadata: {
          service_id,
          service_name,
          quantity,
          platform,
        },
      }),
    });

    const payment = await mpResponse.json();

    if (!mpResponse.ok) {
      console.error('Erro MP:', payment);
      return res.status(400).json({ error: 'Erro ao criar pagamento', details: payment });
    }

    // 2. Retorna o QR Code Pix pro frontend
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
