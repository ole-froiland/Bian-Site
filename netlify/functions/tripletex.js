/* netlify/functions/tripletex.js */
if (process.env.NETLIFY_DEV || process.env.NETLIFY_LOCAL) {
  try { require('dotenv').config(); } catch {}
}
const API_BASE = 'https://api-test.tripletex.tech/v2';
let sessionCache = { token: null, expires: 0 };
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

async function getSessionToken() {
  const now = Date.now();
  if (sessionCache.token && now < sessionCache.expires - 30_000) return sessionCache.token;
  const consumerToken = process.env.TRIPLETEX_CONSUMER_TOKEN;
  const employeeToken = process.env.TRIPLETEX_EMPLOYEE_TOKEN;
  if (!consumerToken || !employeeToken) throw new Error('Missing TRIPLETEX_* env vars');
  const url = new URL(`${API_BASE}/token/session/:create`);
  url.searchParams.set('consumerToken', consumerToken);
  url.searchParams.set('employeeToken', employeeToken);
  url.searchParams.set('expirationDate', new Date(Date.now() + 23*60*60*1000).toISOString());
  const res = await fetch(url, { method: 'PUT', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Session token request failed: ${res.status}`);
  const json = await res.json();
  const token = json?.value?.token;
  if (!token) throw new Error('No session token in response');
  sessionCache = { token, expires: Date.now() + 23*60*60*1000 };
  return token;
}

async function ttGet(path, params = {}) {
  const token = await getSessionToken();
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const auth = b64(`0:${token}`); // companyId=0 works per our manual test
  const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchLedger(dateFrom, dateTo) {
  const pageSize = 1000; let page = 0; let all = [];
  while (true) {
    const data = await ttGet('/ledger/posting', { dateFrom, dateTo, page, count: pageSize });
    const values = data?.values || [];
    all = all.concat(values);
    if (values.length < pageSize) break;
    page++;
  }
  return all;
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
    const defaultTo   = now.toISOString().slice(0,10);
    const dateFrom = qs.from || qs.dateFrom || defaultFrom;
    const dateTo   = qs.to   || qs.dateTo   || defaultTo;

    const BEER_SALES_ACCOUNT_ID = 289896744; // Tripletex account.id for konto 3003
    const postings = await fetchLedger(dateFrom, dateTo);
    const beer = postings
      .filter(p => p?.account?.id === BEER_SALES_ACCOUNT_ID)
      .map(p => ({ id: p.id, date: p.date, amount: Number(p.amount||0) }));
    const totalBeerSales = beer.reduce((s,p)=> s + Math.abs(p.amount||0), 0);

    return { statusCode: 200, headers: {'content-type':'application/json'},
      body: JSON.stringify({ dateFrom, dateTo, totalBeerSales, count: beer.length, postings: beer })
    };
  } catch (err) {
    return { statusCode: 502, headers: {'content-type':'application/json'},
      body: JSON.stringify({ error: err.message || String(err) })
    };
  }
};
