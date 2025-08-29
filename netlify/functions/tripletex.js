const fetch = global.fetch;

let sessionCache = { token: null, expiresAt: 0 };

async function fetchSessionToken() {
  const now = Date.now();
  if (sessionCache.token && now < sessionCache.expiresAt - 5 * 60 * 1000) {
    return sessionCache.token;
  }
  const consumerToken = process.env.TRIPLETEX_CONSUMER_TOKEN;
  const employeeToken = process.env.TRIPLETEX_EMPLOYEE_TOKEN;
  if (!consumerToken || !employeeToken) {
    throw new Error('Missing Tripletex tokens');
  }
  const exp = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const url = new URL('https://api-test.tripletex.tech/v2/token/session/:create');
  url.searchParams.set('consumerToken', consumerToken);
  url.searchParams.set('employeeToken', employeeToken);
  url.searchParams.set('expirationDate', exp);
  const res = await fetch(url.toString(), { method: 'PUT', headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Session error ' + res.status + ' ' + txt);
  }
  const data = await res.json();
  const token = data?.value?.token;
  if (!token) throw new Error('No session token');
  sessionCache = { token, expiresAt: now + 24 * 60 * 60 * 1000 };
  return token;
}

async function apiGet(path, params) {
  const token = await fetchSessionToken();
  const url = new URL('https://api-test.tripletex.tech' + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const auth = Buffer.from('0:' + token).toString('base64');
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: 'Basic ' + auth,
      Accept: 'application/json'
    }
  });
  if (!res.ok) {
    const msg = await res.text();
    const err = new Error('Tripletex error ' + res.status);
    err.status = res.status;
    err.body = msg;
    throw err;
  }
  return res.json();
}

exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed', status: 405 }) };
    }
    const target = event.queryStringParameters?.target;
    if (target === 'ledger') {
      const { dateFrom, dateTo } = event.queryStringParameters;
      if (!dateFrom || !dateTo) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing dateFrom/dateTo', status: 400 }) };
      }
      let page = 0;
      const count = 1000;
      const values = [];
      while (true) {
        const data = await apiGet('/v2/ledger/posting', {
          dateFrom,
          dateTo,
          page: String(page),
          count: String(count),
          fields: 'id,date,amount,account(id,accountNumber,name)'
        });
        const pageVals = data?.values || [];
        values.push(...pageVals);
        if (pageVals.length < count) break;
        page++;
      }
      return { statusCode: 200, body: JSON.stringify({ values }) };
    } else if (target === 'accounts') {
      const data = await apiGet('/v2/account', {
        page: '0',
        count: '1000',
        isActive: 'true',
        fields: 'id,accountNumber,name'
      });
      return { statusCode: 200, body: JSON.stringify({ values: data?.values || [] }) };
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown target', status: 400 }) };
    }
  } catch (err) {
    return { statusCode: err.status || 500, body: JSON.stringify({ error: err.message, status: err.status || 500 }) };
  }
};
