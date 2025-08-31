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
