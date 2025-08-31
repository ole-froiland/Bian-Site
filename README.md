# Bian-Site

## Tripletex integration

Set the following environment variables in a local `.env` file or in Netlify's environment settings before running the site:

```
TRIPLETEX_CONSUMER_TOKEN=...
TRIPLETEX_EMPLOYEE_TOKEN=...
```

### Local development

Create a `.env` file (or copy `.env.example`) and start the dev server:

```bash
npx netlify dev
```

This command automatically loads the `.env` file when running locally.

### Production on Netlify

Set the variables in your Netlify site:

```bash
npx netlify env:set TRIPLETEX_CONSUMER_TOKEN "eyJ0b2tl..."
npx netlify env:set TRIPLETEX_EMPLOYEE_TOKEN "eyJ0b2tl..."
```

You can verify the values with:

```bash
npx netlify env:list
```
