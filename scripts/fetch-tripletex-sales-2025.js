/**
 * Fetch Tripletex voucherlines for every month in 2025 and store sales (accounts 3000–3999)
 * into ./data/YYYY-MM-sales.json.
 *
 * Usage:
 *   TRIPLETEX_SESSION_TOKEN="your_session_token" node scripts/fetch-tripletex-sales-2025.js
 *
 * Auth: Basic user "0", password TRIPLETEX_SESSION_TOKEN
 * Endpoint: https://tripletex.no/v2/voucherline
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.TRIPLETEX_BASE_URL || 'https://tripletex.no/v2';
const SESSION_TOKEN = process.env.TRIPLETEX_SESSION_TOKEN || '';

if (!SESSION_TOKEN) {
  console.error('Missing TRIPLETEX_SESSION_TOKEN');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const authHeader = 'Basic ' + Buffer.from(`0:${SESSION_TOKEN}`).toString('base64');
const pageSize = 100;
const maxPages = 500;
const timeoutMs = 10000;

async function fetchWithTimeout(url, options = {}, timeout = timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchMonth(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0);
  const to = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(
    endDate.getDate()
  ).padStart(2, '0')}`;

  let page = 0;
  const all = [];

  while (page < maxPages) {
    const url = new URL(`${BASE_URL.replace(/\/+$/, '')}/voucherline`);
    url.searchParams.set('fromDate', from);
    url.searchParams.set('toDate', to);
    url.searchParams.set('page', String(page));
    url.searchParams.set('count', String(pageSize));

    console.log(`[${from} -> ${to}] page=${page} ${url.toString()}`);

    const res = await fetchWithTimeout(url.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: authHeader,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Tripletex error ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const values = data?.values || data?.data || data?.voucherlines || [];
    all.push(...values);

    console.log(`  received=${values.length}, total=${all.length}`);

    if (values.length < pageSize) break;
    page += 1;
  }

  if (page >= maxPages) {
    throw new Error('Pagination cap reached');
  }

  return all;
}

function filterSales(lines) {
  return lines.filter((v) => {
    const num = Number(v?.account?.number ?? v?.accountNumber ?? null);
    return Number.isFinite(num) && num >= 3000 && num <= 3999;
  });
}

async function run() {
  for (let month = 1; month <= 12; month += 1) {
    const label = `2025-${String(month).padStart(2, '0')}`;
    try {
      const lines = await fetchMonth(2025, month); // fetch only this month
      const sales = filterSales(lines); // keep only account 3000–3999
      const outPath = path.join(DATA_DIR, `${label}-sales.json`);
      const payload = {
        month: label,
        from: `${label}-01`,
        to: `${label}-${String(new Date(2025, month, 0).getDate()).padStart(2, '0')}`,
        count: sales.length,
        entries: sales,
      };
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
      console.log(`Saved ${sales.length} sales lines to ${outPath}`);
    } catch (e) {
      console.error(`Failed month ${label}:`, e?.message || e);
    }
  }
}

run();
