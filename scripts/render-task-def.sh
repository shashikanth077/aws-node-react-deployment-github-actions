#!/usr/bin/env bash
# Fills the ${PLACEHOLDERS} in infra/task-definition.json from environment variables.
# Usage: ACCOUNT_ID=... AWS_REGION=... IMAGE_URI=... DB_HOST=... DB_SECRET_ARN=... ./scripts/render-task-def.sh
set -euo pipefail

for v in ACCOUNT_ID AWS_REGION IMAGE_URI DB_HOST DB_SECRET_ARN; do
  [ -n "${!v:-}" ] || { echo "Missing env var: $v" >&2; exit 1; }
done

cd "$(dirname "$0")/.."
sed \
  -e "s|\${ACCOUNT_ID}|$ACCOUNT_ID|g" \
  -e "s|\${AWS_REGION}|$AWS_REGION|g" \
  -e "s|\${IMAGE_URI}|$IMAGE_URI|g" \
  -e "s|\${DB_HOST}|$DB_HOST|g" \
  -e "s|\${DB_SECRET_ARN}|$DB_SECRET_ARN|g" \
  infra/task-definition.json > infra/task-definition.rendered.json

echo "Wrote infra/task-definition.rendered.json"
