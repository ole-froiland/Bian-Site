/* Netlify Function: tripletex-sales
 * Aggregates sales (accounts 3000–3999) for a given date range.
 * Auth: Basic user "0", password TRIPLETEX_SESSION_TOKEN (env).
 * Prod endpoint: https://tripletex.no/v2/ledger/posting
 * Robust pagination + timeout to avoid hanging/loops.
 */

const BASE_URL = process.env.TRIPLETEX_BASE_URL || 'https://tripletex.no/v2';
const SESSION_TOKEN = process.env.TRIPLETEX_SESSION_TOKEN || '';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ok = (body) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });
const err = (status, message) => ({ statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ error: message }) });

const nbMonthFmt = new Intl.DateTimeFormat('nb-NO', { month: 'long', year: 'numeric' });

// Small fetch helper with timeout (default 5s)
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return err(405, 'Method not allowed');
    }
    if (!SESSION_TOKEN) {
      return err(500, 'Missing TRIPLETEX_SESSION_TOKEN');
    }

    const q = event.queryStringParameters || {};
    const from = q.from;
    const to = q.to;
    if (!from || !to) {
      return err(400, 'Missing from/to');
    }

    const auth = 'Basic ' + Buffer.from(`0:${SESSION_TOKEN}`).toString('base64');
    const pageSize = 100;
    let page = 0;
    let postings = [];
    const maxPages = 500; // safety cap to avoid infinite loops

    console.log(`[tripletex-sales] Fetching ${from} -> ${to}`);

    while (page < maxPages) {
      const url = new URL(`${BASE_URL.replace(/\/+$/, '')}/ledger/posting`);
      url.searchParams.set('dateFrom', from);
      url.searchParams.set('dateTo', to);
      url.searchParams.set('page', String(page));
      url.searchParams.set('count', String(pageSize));

      console.log(`[tripletex-sales] page=${page} url=${url.toString()}`);

      const res = await fetchWithTimeout(url.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: auth,
        },
      });
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
    return err(500, String(e?.message || e));
  }
};
