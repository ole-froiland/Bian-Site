#!/usr/bin/env bash

set -euo pipefail

# Default credentials – override by exporting before running if needed
: "${LIGHTSPEED_X_TOKEN:=3c8d63ffebb147adb2e0dc6e8b1bd90c306b17d3}"
: "${LIGHTSPEED_BUSINESS_ID:=41258}"
: "${LIGHTSPEED_OPERATOR:=}"

if ! command -v netlify >/dev/null 2>&1; then
  echo "Error: netlify CLI is not installed. Install via 'npm install -g netlify-cli'." >&2
  exit 1
fi

echo "Linking Netlify site (follow prompts if not already linked)..."
netlify link

echo "Setting Lightspeed environment variables on Netlify..."
netlify env:set LIGHTSPEED_X_TOKEN "$LIGHTSPEED_X_TOKEN"
netlify env:set LIGHTSPEED_BUSINESS_ID "$LIGHTSPEED_BUSINESS_ID"
netlify env:set LIGHTSPEED_OPERATOR "$LIGHTSPEED_OPERATOR"

echo "Deploying latest build to production..."
netlify deploy --prod --build

echo "Done. Future deploys will reuse these environment variables automatically."
