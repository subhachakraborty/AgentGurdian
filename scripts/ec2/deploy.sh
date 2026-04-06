#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "Installing dependencies..."
npm ci

echo "Building shared, API, and web..."
npm run build

echo "Applying Prisma migrations..."
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -q '^agent-guardian-api.service'; then
    echo "Restarting agent-guardian-api service..."
    sudo systemctl restart agent-guardian-api
  fi
fi

if command -v nginx >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  if [ -f /etc/nginx/sites-enabled/agent-guardian ] || [ -f /etc/nginx/sites-available/agent-guardian ]; then
    echo "Validating and reloading Nginx..."
    sudo nginx -t
    sudo systemctl reload nginx
  fi
fi

echo "Deployment refresh complete."
