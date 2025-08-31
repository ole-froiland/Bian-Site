if (process.env.NETLIFY_DEV || process.env.NETLIFY_LOCAL) {
  try { require('dotenv').config(); } catch {}
}

const API_BASE = 'https://api-test.tripletex.tech/v2';
let sessionCache = { token: null, expires: 0 };
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

async function getSessionToken() {
  const now = Date.now();
  if (sessionCache.token && now < sessionCache.expires - 30_000) {
    return sessionCache.token;
  }
  const consumerToken = process.env.TRIPLETEX_CONSUMER_TOKEN;
  const employeeToken = process.env.TRIPLETEX_EMPLOYEE_TOKEN;
  if (!consumerToken || !employeeToken) {
    throw new Error('Missing TRIPLETEX_* env vars');
  }
  const expiration = new Date(now + 23 * 60 * 60 * 1000).toISOString();
  const url = new URL(`${API_BASE}/token/session/:create`);
  url.searchParams.set('consumerToken', consumerToken);
  url.searchParams.set('employeeToken', employeeToken);
  url.searchParams.set('expirationDate', expiration);
  const res = await fetch(url, { method: 'PUT', headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Session token request failed: ${res.status}`);
  }
  const json = await res.json();
  const token = json?.value?.token;
  if (!token) throw new Error('No session token in response');
  sessionCache = { token, expires: now + 23 * 60 * 60 * 1000 };
  return token;
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const dateFrom = qs.from || qs.dateFrom || new Date().toISOString().slice(0, 10);
    const dateTo = qs.to || qs.dateTo || dateFrom;
    const sessionToken = await getSessionToken();
    const url = new URL(`${API_BASE}/ledger/posting`);
    url.searchParams.set('dateFrom', dateFrom);
    url.searchParams.set('dateTo', dateTo);
    url.searchParams.set('page', '0');
    url.searchParams.set('count', '1000');
    const auth = b64(`0:${sessionToken}`);
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${auth}`
      }
    });
    if (!res.ok) {
      throw new Error(`Ledger request failed: ${res.status}`);
    }
    const data = await res.json();
    const postings = (data.values || []).filter(p => p?.account?.id === 289896744);
    const totalBeerSales = postings.reduce((sum, p) => sum + Math.abs(Number(p.amount) || 0), 0);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totalBeerSales, postings })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: err.message || String(err) })
    };
  }
};
