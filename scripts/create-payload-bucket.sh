#!/usr/bin/env bash
set -euo pipefail

# Creates the payload-media bucket in the local MinIO instance.
# Idempotent — safe to run multiple times.
# Requires the supabase compose stack to be running (the minio service).

ENDPOINT="${STORAGE_S3_ENDPOINT:-http://localhost:9000}"
ACCESS_KEY="${MINIO_ROOT_USER:?MINIO_ROOT_USER must be set}"
SECRET_KEY="${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD must be set}"
BUCKET="${PAYLOAD_S3_BUCKET:-payload-media}"

if ! command -v mc >/dev/null 2>&1; then
  echo "mc (MinIO client) not found on PATH. Install: https://min.io/docs/minio/linux/reference/minio-mc.html" >&2
  exit 1
fi

mc alias set payload-local "$ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null
mc mb --ignore-existing "payload-local/$BUCKET"
echo "Bucket payload-local/$BUCKET ready."
