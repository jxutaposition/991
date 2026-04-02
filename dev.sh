#!/usr/bin/env bash
set -e

echo "Starting n8n (Docker)..."
docker compose up -d n8n

echo "Waiting for n8n to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:5678/healthz > /dev/null 2>&1; then
    echo "n8n is ready at http://localhost:5678"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Warning: n8n did not respond within 30s, continuing anyway"
  fi
  sleep 1
done

echo ""
echo "Starting backend..."
cd backend && cargo run
