#!/usr/bin/env bash
# Creates .env.docker from the example, with freshly generated secrets. Never overwrites an existing file.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -e .env.docker ]; then
  echo ".env.docker already exists; leaving it alone."
  exit 0
fi

cp .env.docker.example .env.docker
for key in JWT_ACCESS_SECRET DATA_ENCRYPTION_KEY; do
  perl -pi -e "s/^$key=.*/$key=$(openssl rand -hex 32)/" .env.docker
done
# Hex only, so it is safe inside the database URL.
perl -pi -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env.docker
echo "Created .env.docker with fresh secrets."
