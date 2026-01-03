/* Netlify Function: tripletex-sales
 * Aggregates sales (accounts 3000–3999) for a given date range.
 * Auth: Basic user "0", password TRIPLETEX_SESSION_TOKEN (env).
 * Prod endpoint: https://tripletex.no/v2/ledger/posting
 * Robust pagination + timeout to avoid hanging/loops.
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.TRIPLETEX_BASE_URL || 'https://tripletex.no/v2';
const SESSION_TOKEN = process.env.TRIPLETEX_SESSION_TOKEN || '';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ok = (body) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });
const err = (status, message) => ({ statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ error: message }) });

const nbMonthFmt = new Intl.DateTimeFormat('nb-NO', { month: 'long', year: 'numeric' });

let cachedTripletex = new Map();

function resolveCachedDatasetDir(){
  const override = process.env.CACHED_DATASET_DIR;
  if (override && fs.existsSync(override)) return override;
  const cwdPath = path.join(process.cwd(), '.netlify', 'cached-dataset-all');
  if (fs.existsSync(cwdPath)) return cwdPath;
  const localPath = path.resolve(__dirname, '..', '..', '.netlify', 'cached-dataset-all');
  if (fs.existsSync(localPath)) return localPath;
  return null;
}

function monthKeyFromIso(iso){
  if (!iso) return null;
  const match = String(iso).match(/^(\d{4})-(\d{2})-/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function loadCachedTripletexMonth(monthKey){
  if (!monthKey) return null;
  if (cachedTripletex.has(monthKey)) return cachedTripletex.get(monthKey);
  const dir = resolveCachedDatasetDir();
  if (!dir) return null;
  const file = path.join(dir, `tripletex-${monthKey}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    cachedTripletex.set(monthKey, parsed);
    return parsed;
  } catch (_) {
    return null;
  }
}

function buildCachedSalesPayload(from, to){
  const monthKey = monthKeyFromIso(to) || monthKeyFromIso(from);
  if (!monthKey) return null;
  const data = loadCachedTripletexMonth(monthKey);
  if (!data) return null;
  const kpi = data?.kpi || {};
  const salesCandidates = [kpi.sales, kpi.salesCore, kpi.salesRaw];
  const totalSales = salesCandidates.find((value) => Number.isFinite(Number(value)));
  const labelDate = new Date(`${monthKey}-01T00:00:00`);
  const monthLabel = Number.isNaN(labelDate.getTime()) ? `${from} – ${to}` : nbMonthFmt.format(labelDate);
  return {
    monthLabel: monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1),
    totalSales: Number(totalSales || 0),
    count: 0,
    mode: 'cached',
  };
}

// Fetch helper with timeout guard (race) so we never hang if abort isn't supported
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`fetch timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetch(url, options),
      timeoutPromise
    ]);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return err(405, 'Method not allowed');
    }

    const q = event.queryStringParameters || {};
    const from = q.from;
    const to = q.to;
    if (!from || !to) {
      return err(400, 'Missing from/to');
    }

    const cachedPayload = buildCachedSalesPayload(from, to);
    if (q.cache === '1' && cachedPayload) {
      return ok(cachedPayload);
    }
    if (!SESSION_TOKEN) {
      if (cachedPayload) return ok(cachedPayload);
      return err(500, 'Missing TRIPLETEX_SESSION_TOKEN');
    }

    const auth = 'Basic ' + Buffer.from(`0:${SESSION_TOKEN}`).toString('base64');
    const pageSize = 100;
    let page = 0;
    let postings = [];
    const maxPages = 500; // safety cap to avoid infinite loops
    const started = Date.now();
    const overallTimeoutMs = 25000; // hard stop to avoid 30s lambda timeout

    console.log(`[tripletex-sales] Fetching ${from} -> ${to}`);

    while (page < maxPages) {
      if (Date.now() - started > overallTimeoutMs) {
        console.error('[tripletex-sales] Overall timeout reached');
        return err(504, 'Timeout while fetching Tripletex postings');
      }
      const url = new URL(`${BASE_URL.replace(/\/+$/, '')}/ledger/posting`);
      url.searchParams.set('dateFrom', from);
      url.searchParams.set('dateTo', to);
      url.searchParams.set('page', String(page));
      url.searchParams.set('count', String(pageSize));

      console.log(`[tripletex-sales] page=${page} url=${url.toString()}`);

      const res = await fetchWithTimeout(
        url.toString(),
        {
          headers: {
            Accept: 'application/json',
            Authorization: auth,
          },
        },
        5000
      );
      if (!res.ok) {
        const text = await res.text();
        console.error(`[tripletex-sales] Tripletex error status=${res.status} body=${text.slice(0, 300)}`);
        return err(res.status, `Tripletex error ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = await res.json();
      const values = data?.values || data?.data || data?.postings || [];
      postings = postings.concat(values);

      console.log(`[tripletex-sales] page=${page} received=${values.length}, total=${postings.length}`);

      if (values.length < pageSize) break;
      page += 1;
    }

    if (page >= maxPages) {
      console.error('[tripletex-sales] Reached maxPages cap, aborting');
      return err(500, 'Pagination cap reached without completion');
    }

    const sales = postings.filter((p) => {
      const num = Number(p?.account?.number ?? p?.accountNumber ?? null);
      return Number.isFinite(num) && num >= 3000 && num <= 3999;
    });
    const totalSales = sales.reduce((sum, p) => sum + Number(p?.amount || 0), 0);

    const labelDate = new Date(`${from}T00:00:00`);
    const monthLabel = Number.isNaN(labelDate.getTime()) ? `${from} – ${to}` : nbMonthFmt.format(labelDate);

    return ok({
      monthLabel: monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1),
      totalSales,
      count: postings.length,
    });
  } catch (e) {
    console.error('[tripletex-sales] Unexpected error:', e);
    const cachedPayload = buildCachedSalesPayload(
      event?.queryStringParameters?.from,
      event?.queryStringParameters?.to
    );
    if (cachedPayload) return ok(cachedPayload);
    return err(500, String(e?.message || e));
  }
};
