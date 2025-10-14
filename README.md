# Bian-Site

## Tripletex integration

Set the following environment variables in a local `.env` file or in Netlify's environment settings before running the site:

```
TRIPLETEX_CONSUMER_TOKEN=eyJ0b2tlbklkIjo0NDUsInRva2VuIjoidGVzdC0yMmViNmNjMC1lMWMzLTQ4OWItYmMwNi1jM2RlMWJkOGI3NjIifQ==
TRIPLETEX_EMPLOYEE_TOKEN=eyJ0b2tlbklkIjo2MjgsInRva2VuIjoidGVzdC1iMGM0YzY1Zi1kOTY2LTQ2MGEtYTJlZi00NzI4NjcyMjQ2NmIifQ==
```

Ledger lookups for account **3003** use `accountId=289896744` against Tripletex.

### Local development

Create a `.env` file (or copy `.env.example`) and start the dev server:

```bash
npx netlify dev
```

This command automatically loads the `.env` file when running locally.

### Production on Netlify

Set the variables in your Netlify site:

```bash
npx netlify env:set TRIPLETEX_CONSUMER_TOKEN "eyJ0b2tlbklkIjo0NDUsInRva2VuIjoidGVzdC0yMmViNmNjMC1lMWMzLTQ4OWItYmMwNi1jM2RlMWJkOGI3NjIifQ=="
npx netlify env:set TRIPLETEX_EMPLOYEE_TOKEN "eyJ0b2tlbklkIjo2MjgsInRva2VuIjoidGVzdC1iMGM0YzY1Zi1kOTY2LTQ2MGEtYTJlZi00NzI4NjcyMjQ2NmIifQ=="
```

You can verify the values with:

```bash
npx netlify env:list
```

## Tripletex beer sales
**Local dev**
```bash
npm install
cp .env.example .env
netlify dev
```

## Lightspeed (Gastrofix) integration

Add these variables to `.env` (placeholders) and set real values in Netlify:

```
LIGHTSPEED_GASTROFIX_BASE_URL=https://no.gastrofix.com/api/
LIGHTSPEED_X_TOKEN=<your-x-token>
LIGHTSPEED_BUSINESS_ID=<your-business-id>
LIGHTSPEED_OPERATOR=<optional-operator-id>
```

The Netlify Function `/.netlify/functions/lightspeed` exposes:
- `GET ?ping=1` health check
- `GET ?env=1` env flags (no secrets)
- `GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=3&metric=revenue` returns `{ top: [ { name, qty, revenue } ] }`
- `GET ?periodId=<period-id>&limit=5` returns `{ totalRevenue, items, top }` summarised from the transactions endpoint

In the dashboard, use the “Lightspeed – Topp 3 produkter” card and click Hent after choosing months.

### Local testing via Netlify dev

```bash
netlify dev
# then in another terminal
curl "http://localhost:8888/.netlify/functions/lightspeed?from=2024-08-01&to=2024-08-31&limit=3" | jq
# or fetch a single period summary
curl "http://localhost:8888/.netlify/functions/lightspeed?periodId=123456&limit=5" | jq
```

### CLI usage (terminal)

Run via local Netlify function (recommended for no secrets in CLI):

```bash
netlify dev &
node scripts/lightspeed-top.js --from 2024-08-01 --to 2024-08-31 --limit 3 --use-function

# fetch a specific Lightspeed periode via proxy (recommended)
node scripts/lightspeed-top.js --period 123456 --limit 5 --use-function
```

Or call Lightspeed directly (requires env vars locally):

```bash
export LIGHTSPEED_GASTROFIX_BASE_URL=https://no.gastrofix.com/api/
export LIGHTSPEED_X_TOKEN=... # your token
export LIGHTSPEED_BUSINESS_ID=... # your business id
node scripts/lightspeed-top.js --from 2024-08-01 --to 2024-08-31 --limit 3

# or, with direct API access, fetch a single periode
node scripts/lightspeed-top.js --period 123456 --limit 5
```
