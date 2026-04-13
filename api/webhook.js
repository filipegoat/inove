export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SMM_API_KEY = process.env.SMM_API_KEY; // c64471f2dd55329c454f5c5e17fbff6d

  try {
    const { type, data } = req.body;

    // Mercado Pago só notifica pagamentos
    if (type !== 'payment') return res.status(200).json({ ok: true });

    // 1. Busca os detalhes do pagamento no MP
    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const payment = await mpResponse.json();

    // 2. Só processa se o pagamento foi aprovado
    if (payment.status !== 'approved') {
      return res.status(200).json({ ok: true, status: payment.status });
    }

    // 3. Pega os dados do pedido que vieram no metadata
    const { service_id, quantity, platform } = payment.metadata;

    // 4. Envia o pedido para a API SMMKings
    const smmBody = new URLSearchParams({
      key: SMM_API_KEY,
      action: 'add',
      service: service_id,
      link: `https://instagram.com/placeholder`, // idealmente vem do frontend
      quantity: quantity,
    });

    const smmResponse = await fetch('https://smmkings.com/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: smmBody.toString(),
    });

    const smmData = await smmResponse.json();
    console.log('Pedido SMMKings:', smmData);

    return res.status(200).json({ ok: true, order: smmData });

  } catch (err) {
    console.error('Webhook erro:', err);
    return res.status(500).json({ error: err.message });
  }
}
