#!/usr/bin/env bash
# NOTE: libnvds_redis_proto.so ships with DeepStream 6.3+.
# If this container does not include it, perception events cannot reach Redis.
# Fallback option: use type=6 with Kafka proto lib + a redis-sidecar, or switch sink1 to type=3 (file).
# Check with: docker exec vss-rt-cv ls /opt/nvidia/deepstream/deepstream/lib/libnvds_redis_proto.so

set -euo pipefail

# Patch the Redis host into the perception config
CONFIG=/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/perception-config.txt
sed -i "s/REDIS_HOST_PLACEHOLDER/${REDIS_HOST:-redis}/g" "$CONFIG"

# Download model if not already present
MODEL_DIR=/data/models/trafficcamnet_transformer
ENGINE=${MODEL_DIR}/resnet50_trafficcamnet_transformer.etlt_b1_gpu0_fp16.engine

if [ ! -f "$ENGINE" ]; then
  if ! command -v ngc &>/dev/null; then
    echo "[ds-start] ERROR: ngc CLI not found in container. Mount the model manually to $MODEL_DIR and retry."
    exit 1
  fi
  echo "[ds-start] Downloading TrafficCamNet model from NGC..."
  mkdir -p "$MODEL_DIR"
  ngc registry model download-version \
    "nvidia/tao/trafficcamnet_transformer_lite:deployable_resnet50_v2.0" \
    --dest "$MODEL_DIR"
  echo "[ds-start] Model download complete."
else
  echo "[ds-start] Model already present, skipping download."
fi

# SDR manages stream sources dynamically — start DeepStream with the base config
# vss-rt-cv's own entrypoint or deepstream-app handles stream updates from SDR
echo "[ds-start] Starting DeepStream perception pipeline..."
exec deepstream-app -c "$CONFIG"
