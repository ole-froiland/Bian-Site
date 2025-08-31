// Netlify Function: Tripletex proxy for ledger postings (account 3003)
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const ok = (body) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });
const bad = (code, msg, extra = {}) => ({
  statusCode: code,
  headers: JSON_HEADERS,
  body: JSON.stringify({ error: msg, ...extra }),
});

// Parse DD.MM.YYYY or YYYY-MM-DD -> YYYY-MM-DD
function normalizeDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  return null;
}

function envRequired(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function createSessionToken(baseUrl, consumerToken, employeeToken, companyId) {
  // Tripletex API: POST /v2/token/session/:create
  // Autorisasjon kan leveres som Basic (consumer:employee) *og*/eller egne headere.
  // Vi setter begge for kompatibilitet.
  const basic = Buffer.from(`${consumerToken}:${employeeToken}`).toString('base64');
  const url = `${baseUrl}/v2/token/session/:create`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'consumerToken': consumerToken,
      'employeeToken': employeeToken,
      ...(companyId ? { 'companyId': String(companyId) } : {}),
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Session token failed: HTTP ${res.status} ${res.statusText} ${text}`);
  }

  const j = await res.json().catch(() => ({}));
  // Tripletex svarer typisk { value: "<sessionToken>" } eller { token: "<...>" }
  const token = j.value || j.token || j.sessionToken || j?.value?.token;
  if (!token) throw new Error(`No session token in response: ${JSON.stringify(j).slice(0,300)}`);
  return token;
}

async function fetchLedger(baseUrl, sessionToken, from, to, accountNumber = 3003) {
  // Paginer til vi er tomme. Tripletex har litt ulike parameternavn; prøv count/page og pageSize/page.
  let page = 0;
  const pageSize = 1000;
  const postings = [];

  async function onePage(p) {
    const qsVariants = [
      `fromDate=${from}&toDate=${to}&accountNumber=${accountNumber}&page=${p}&count=${pageSize}`,
      `fromDate=${from}&toDate=${to}&accountNumber=${accountNumber}&page=${p}&pageSize=${pageSize}`,
    ];
    for (const qs of qsVariants) {
      const url = `${baseUrl}/v2/ledger/posting?${qs}`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
      });
      if (res.status === 429) {
        // rate limit – kort pause og prøv igjen samme variant
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ledger fetch failed: HTTP ${res.status} ${res.statusText} ${text}`);
      }
      const j = await res.json().catch(() => ({}));
      // Tripletex returnerer ofte { values: [ ... ], fullResultSize: N } eller { data: [...] }
      const arr = j.values || j.data || j.postings || [];
      return { arr, meta: j };
    }
    throw new Error('All query variants failed for ledger endpoint');
  }

  // Hent til tom
  while (true) {
    const { arr, meta } = await onePage(page);
    postings.push(...arr.map(x => ({
      id: x.id ?? x.voucherId ?? x.number ?? null,
      date: x.date || x.voucherDate || x.transactionDate || null,
      amount: Number(x.amount || x.amountNok || x.value || 0),
    })));

    const total = meta.fullResultSize || meta.totalCount || meta.total || null;
    if (arr.length < pageSize) break; // siste side
    if (total && postings.length >= total) break;

    page += 1;
    // liten pause for ikke å bli throttlet
    await new Promise(r => setTimeout(r, 120));
  }

  return postings;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return bad(405, 'Method Not Allowed');
    }

    const q = event.queryStringParameters || {};
    if (q.ping) return ok({ ok: true, service: 'tripletex-proxy' });

    // Demo-modus for enkel test
    const demo = q.demo === '1' || process.env.TRIPLETEX_DEMO === '1';

    let from = normalizeDate(q.from);
    let to   = normalizeDate(q.to);

    if (!from || !to) {
      // Default YTD
      const now = new Date();
      const ytd = new Date(now.getFullYear(), 0, 1);
      const y  = ytd.getFullYear();
      const mm = String(ytd.getMonth()+1).padStart(2,'0');
      const dd = String(ytd.getDate()).padStart(2,'0');
      from = `${y}-${mm}-${dd}`;
      const m2 = String(now.getMonth()+1).padStart(2,'0');
      const d2 = String(now.getDate()).padStart(2,'0');
      to = `${now.getFullYear()}-${m2}-${d2}`;
    }
    if (from > to) [from, to] = [to, from];

    if (demo) {
      // generer enkel demodata
      const base = new Date(from);
      const items = Array.from({length: 8}).map((_, i) => {
        const d = new Date(base); d.setDate(d.getDate() + i*3);
        const mm = String(d.getMonth()+1).padStart(2,'0');
        const dd = String(d.getDate()).padStart(2,'0');
        return { id: 1000+i, date: `${d.getFullYear()}-${mm}-${dd}`, amount: Math.round((Math.random()*4000+500)*(Math.random()>0.2?1:-1)) };
      });
      const total = items.reduce((a,b)=>a+Math.abs(b.amount),0);
      return ok({ dateFrom: from, dateTo: to, count: items.length, totalBeerSales: total, postings: items });
    }

    const baseUrl = (process.env.TRIPLETEX_BASE_URL || 'https://tripletex.no').replace(/\/+$/,'');
    const consumer = envRequired('TRIPLETEX_CONSUMER_TOKEN');
    const employee = envRequired('TRIPLETEX_EMPLOYEE_TOKEN');
    const companyId = process.env.TRIPLETEX_COMPANY_ID || null;

    const session = await createSessionToken(baseUrl, consumer, employee, companyId);
    const postings = await fetchLedger(baseUrl, session, from, to, 3003);

    const total = postings.reduce((acc, p) => acc + Math.abs(Number(p.amount || 0)), 0);
    return ok({ dateFrom: from, dateTo: to, count: postings.length, totalBeerSales: total, postings });
  } catch (err) {
    // Kontrollerte feilsvar så vi slipper 502
    const msg = String(err && err.message ? err.message : err);
    // Manglende env → 500, ellers 502
    const isEnv = /Missing env/.test(msg);
    const code = isEnv ? 500 : 502;
    return bad(code, msg);
  }
};

