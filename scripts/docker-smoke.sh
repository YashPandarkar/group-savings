#!/usr/bin/env bash
# Builds and starts the containers under a SEPARATE project name and port, checks them, then removes them.
# It never touches your normal docker:up containers or their database volume.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=groupsavings-smoke
export API_HOST_PORT=4200
BASE="http://localhost:${API_HOST_PORT}"
compose() { docker compose -p "$PROJECT" -f docker-compose.app.yml --env-file .env.docker "$@"; }

cleanup() { compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

compose up -d --build

ok=0
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  echo "API did not become healthy. Logs:"
  compose logs --tail=80
  exit 1
fi

curl -fsS "$BASE/api/health/db" | grep -q '"up"'
curl -fsS "$BASE/" | grep -q 'id="root"'
curl -fsS "$BASE/loans/123" | grep -q 'id="root"'          # a deep link still serves the app
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/nope")" = "404" ]
[ "$(compose exec -T api id -u)" != "0" ]                   # not running as root

echo "✅ Docker smoke test passed"
