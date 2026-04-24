// Cache em memória — evita chamar a API SMMKings a cada request de usuário
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

export default async function handler(req, res) {
  // CORS restrito ao seu domínio — NUNCA use '*' em produção
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  // API key SOMENTE via variável de ambiente — nunca no código
  const SMM_API_KEY = process.env.SMM_API_KEY;
  if (!SMM_API_KEY) {
    console.error('SMM_API_KEY não configurada');
    return res.status(500).json({ error: 'Configuração interna inválida' });
  }

  // Retorna cache se ainda válido
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) {
    return res.status(200).json(_cache);
  }

  try {
    const response = await fetch('https://smmkings.com/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: SMM_API_KEY, action: 'services' }).toString(),
      signal: AbortSignal.timeout(10000), // timeout de 10s
    });

    if (!response.ok) throw new Error('Falha ao contatar provedor');

    const data = await response.json();
    _cache = data;
    _cacheTime = Date.now();

    return res.status(200).json(data);
  } catch (err) {
    // Se tiver cache expirado, retorna ele em vez de erro
    if (_cache) return res.status(200).json(_cache);
    console.error('Erro services.js:', err.message);
    // Nunca expõe detalhes internos ao cliente
    return res.status(502).json({ error: 'Serviços temporariamente indisponíveis' });
  }
}
