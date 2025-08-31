# Bian-Site

## Tripletex integration

Set the following environment variables in Netlify or a local `.env` file before running the site:

```
TRIPLETEX_CONSUMER_TOKEN=...
TRIPLETEX_EMPLOYEE_TOKEN=...
```

### Local development

1. Copy `.env.example` to `.env` and fill in your real tokens.
2. Start the dev server:

   ```bash
   npx netlify dev
   ```

### Production on Netlify

Set the variables in your Netlify site:

```bash
npx netlify env:set TRIPLETEX_CONSUMER_TOKEN <your-consumer-token>
npx netlify env:set TRIPLETEX_EMPLOYEE_TOKEN <your-employee-token>
```

You can verify the values with:

```bash
npx netlify env:list
```
