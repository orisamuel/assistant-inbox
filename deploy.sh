#!/bin/bash
# Push the Apps Script backend and publish a new version on the SAME web-app URL.
# Usage: ./deploy.sh "what changed"
# Fill DEPLOYMENT_ID once, from the output of the first `clasp deploy`.
# Runs from the folder that holds .clasp.json (the project root in the kiosk-42 layout).
set -e
DEPLOYMENT_ID="AKfycbwPIplTyvr0gUPlPTsVMVOL1WcgGw-sc_3GNUQI0MpcEZDFskeMRpskI1nJiyaR7AJP"
cd "$(dirname "$0")"
npx @google/clasp@2.4.2 push -f
npx @google/clasp@2.4.2 deploy -i "$DEPLOYMENT_ID" -d "${1:-update}"
