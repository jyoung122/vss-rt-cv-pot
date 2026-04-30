#!/usr/bin/env bash
# NOTE: libnvds_redis_proto.so ships with DeepStream 6.3+.
# If this container does not include it, perception events cannot reach Redis.
# Fallback option: use type=6 with Kafka proto lib + a redis-sidecar, or switch sink1 to type=3 (file).
# Check with: docker exec vss-rt-cv ls /opt/nvidia/deepstream/deepstream/lib/libnvds_redis_proto.so

set -euo pipefail

# Stage configs in a writable dir so deepstream-app can resolve relative `config-file=` paths
SRC_DIR=/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app
WORK_DIR=/tmp/ds-config
CONFIG=$WORK_DIR/perception-config.txt
mkdir -p "$WORK_DIR"
cp "$SRC_DIR/perception-config.txt" "$SRC_DIR/rtdetr-960x544.txt" "$SRC_DIR/rtdetr-960x544-labels.txt" "$SRC_DIR/config_tracker_IOU.yml" "$SRC_DIR/dstest5_msgconv_sample_config.txt" "$WORK_DIR/"

sed -i "s/REDIS_HOST_PLACEHOLDER/${REDIS_HOST:-redis}/g" "$CONFIG"

URL_FILE=/data/videos/current_stream_url.txt
if [ -f "$URL_FILE" ] && [ -s "$URL_FILE" ]; then
  STREAM_URI=$(cat "$URL_FILE")
  echo "[ds-start] Using stream URI from file: $STREAM_URI"
fi
sed -i "s|STREAM_URI_PLACEHOLDER|${STREAM_URI:-rtsp://nvstreamer:30554/placeholder}|g" "$CONFIG"

# Model check: engine is built on first run from the .etlt source file.
# Skip NGC download if either the pre-built engine or the source .etlt is present.
MODEL_DIR=/data/models/trafficcamnet_transformer
ENGINE=${MODEL_DIR}/resnet50_trafficcamnet_rtdetr.fp16.onnx_b1_gpu0_fp16.engine
ONNX=${MODEL_DIR}/resnet50_trafficcamnet_rtdetr.fp16.onnx

if [ -f "$ENGINE" ]; then
  echo "[ds-start] Pre-built engine found, skipping download."
elif [ -f "$ONNX" ]; then
  echo "[ds-start] ONNX model found — DeepStream will build the TRT engine on first run (~60-120s)."
else
  if ! command -v ngc &>/dev/null; then
    echo "[ds-start] ERROR: ngc CLI not found. Mount the model to $MODEL_DIR and retry."
    exit 1
  fi
  echo "[ds-start] Downloading TrafficCamNet model from NGC..."
  mkdir -p "$MODEL_DIR"
  ngc registry model download-version \
    "nvidia/tao/trafficcamnet_transformer_lite:deployable_resnet50_v2.0" \
    --dest "$MODEL_DIR"
  echo "[ds-start] Model download complete."
fi

# SDR manages stream sources dynamically — start DeepStream with the base config
# vss-rt-cv's own entrypoint or deepstream-app handles stream updates from SDR
echo "[ds-start] Starting metropolis_perception_app..."
cd "$WORK_DIR"
exec /opt/nvidia/deepstream/deepstream-9.0/sources/apps/sample_apps/metropolis_perception_app/metropolis_perception_app -c "$CONFIG" -m 7 -r 2
