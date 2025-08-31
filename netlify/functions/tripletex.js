if (process.env.NETLIFY_DEV || process.env.NETLIFY_LOCAL) { try { require('dotenv').config(); } catch {} }

const API_BASE = 'https://api-test.tripletex.tech/v2';
let cachedSession = { token: null, expiresAt: 0 };
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

async function ensureSession() {
  const now = Date.now();
  if (cachedSession.token && now < cachedSession.expiresAt - 30_000) return cachedSession.token;

  const consumerToken = process.env.TRIPLETEX_CONSUMER_TOKEN;
  const employeeToken = process.env.TRIPLETEX_EMPLOYEE_TOKEN;
  if (!consumerToken || !employeeToken) throw new Error('Missing TRIPLETEX_* env vars');

  const expISO = new Date(now + 23 * 60 * 60 * 1000).toISOString();
  const url = new URL(`${API_BASE}/token/session/:create`);
  url.searchParams.set('consumerToken', consumerToken);
  url.searchParams.set('employeeToken', employeeToken);
  url.searchParams.set('expirationDate', expISO);

  const res = await fetch(url, { method: 'PUT', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Session failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const token = json?.value?.token;
  if (!token) throw new Error('No token returned');
  cachedSession = { token, expiresAt: now + 23 * 60 * 60 * 1000 };
  return token;
}

async function ttGet(path, params = {}) {
  const token = await ensureSession();
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Basic ${b64(`0:${token}`)}` }
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function resolveAccountId(accountNumber) {
  const pageSize = 100, wanted = String(accountNumber);
  let page = 0;
  while (true) {
    const data = await ttGet('/account', { number: wanted, page, count: pageSize });
    const values = data?.values || [];
    const exact = values.find(a => String(a.number ?? a.accountNumber) === wanted);
    if (exact) return { id: exact.id, name: exact.name || 'Ukjent konto' };
    if (values.length < pageSize) break;
    page++;
  }
  throw new Error(`Account not found: ${wanted}`);
}

async function fetchLedgerByAccountId(accountId, dateFrom, dateTo) {
  const pageSize = 1000; let page = 0, all = [];
  while (true) {
    const data = await ttGet('/ledger/posting', { accountId, dateFrom, dateTo, page, count: pageSize });
    const values = data?.values || [];
    all = all.concat(values.map(v => ({ id: v.id, date: v.date, amount: Number(v.amount || 0) })));
    if (values.length < pageSize) break;
    page++;
  }
  return all;
}

const ok  = x => ({ statusCode: 200, headers: {'content-type':'application/json'}, body: JSON.stringify(x) });
const err = (s,e,d) => ({ statusCode: s, headers: {'content-type':'application/json'}, body: JSON.stringify({ error:e, detail:d }) });

exports.handler = async (event) => {
  try {
    if (!event.path.endsWith('/sales')) return err(404, 'NotFound', 'Use /.netlify/functions/tripletex/sales');
    const qs = new URLSearchParams(event.queryStringParameters || {});
    const accountNumber = Number(qs.get('accountNumber') || 3003); // default Øl-salg
    const now = new Date();
    const dateFrom = qs.get('dateFrom') || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
    const dateTo   = qs.get('dateTo')   || now.toISOString().slice(0,10);

    const { id: accountId, name: accountName } = await resolveAccountId(accountNumber);
    const postings = await fetchLedgerByAccountId(accountId, dateFrom, dateTo);
    const totalNOK = Math.abs(postings.reduce((s,p)=> s + (Number.isFinite(p.amount)?p.amount:0), 0));
    return ok({ accountNumber, accountName, dateFrom, dateTo, count: postings.length, totalNOK, postings });
  } catch (e) { return err(502, 'TripletexError', e instanceof Error ? e.message : String(e)); }
};
