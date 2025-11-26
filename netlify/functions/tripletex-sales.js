/* Netlify Function: tripletex-sales
 * Aggregates sales (accounts 3000–3999) for a given date range.
 * Auth: Basic user "0", password TRIPLETEX_SESSION_TOKEN (env).
 * Prod endpoint: https://tripletex.no/v2/ledger/posting
 */
const BASE_URL = process.env.TRIPLETEX_BASE_URL || 'https://tripletex.no/v2';
const SESSION_TOKEN = process.env.TRIPLETEX_SESSION_TOKEN || '';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ok = (body) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });
const err = (status, message) => ({ statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ error: message }) });

const nbMonthFmt = new Intl.DateTimeFormat('nb-NO', { month: 'long', year: 'numeric' });

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
    const count = 1000;
    let page = 0;
    let postings = [];

    while (page < 200) {
      const url = new URL(`${BASE_URL.replace(/\/+$/, '')}/ledger/posting`);
      url.searchParams.set('dateFrom', from);
      url.searchParams.set('dateTo', to);
      url.searchParams.set('page', String(page));
      url.searchParams.set('count', String(count));
      const res = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: auth,
        },
      });
      if (!res.ok) {
        const text = await res.text();
        return err(res.status, `Tripletex error ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = await res.json();
      const values = data?.values || data?.data || data?.postings || [];
      postings = postings.concat(values);
      if (!values.length || values.length < count) break;
      page += 1;
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
    });
  } catch (e) {
    return err(500, String(e?.message || e));
  }
};
