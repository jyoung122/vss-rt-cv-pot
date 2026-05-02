#!/usr/bin/env bash
# Bring up the dev stack cleanly.
# Tears down any leftover containers/networks from a previous run before starting,
# so you never hit "container name already in use" conflicts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.dev.yml"

cd "$REPO_ROOT"

echo "→ Stopping and removing any previous dev containers..."
docker compose -f "$COMPOSE_FILE" down --remove-orphans

# Force-remove by name in case containers were started under a different
# Compose project name and survived the `down` above.
for name in aims-redis-dev aims-postgres-dev aims-backend-dev; do
  if docker ps -aq --filter "name=^${name}$" | grep -q .; then
    echo "  force-removing stale container: $name"
    docker rm -f "$name"
  fi
done

echo "→ Building images..."
docker compose -f "$COMPOSE_FILE" build

echo "→ Starting dev stack..."
docker compose -f "$COMPOSE_FILE" up -d

echo ""
echo "Dev stack is up. Useful commands:"
echo "  docker compose -f docker-compose.dev.yml logs -f"
echo "  cd frontend && npm run dev   (HMR on :3000)"
