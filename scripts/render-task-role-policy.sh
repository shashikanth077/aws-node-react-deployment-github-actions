#!/usr/bin/env bash
# Usage: DB_SECRET_ARN=arn:aws:secretsmanager:... ./scripts/render-task-role-policy.sh > /tmp/task-role-policy.json
set -euo pipefail
: "${DB_SECRET_ARN:?Missing DB_SECRET_ARN}"
cd "$(dirname "$0")/.."
sed "s|\${DB_SECRET_ARN}|$DB_SECRET_ARN|g" infra/task-role-policy.json
