#!/usr/bin/env bash
# Take a "warm" AMI of the running instance — captures pulled NIM images,
# TRT engine cache, and Postgres state. Run AFTER smoke test passes.
#
# --no-reboot is omitted intentionally: we want a consistent snapshot.
# Instance will be rebooted by AWS during image creation (~1 min downtime).

set -euo pipefail
cd "$(dirname "$0")"
. ./00-config.sh
_load_state

_require INSTANCE_ID

NAME="${PROJECT_TAG}-warm-$(date +%Y%m%d-%H%M)"
echo "==> Creating AMI $NAME from $INSTANCE_ID"
echo "    (instance will be briefly rebooted for a consistent snapshot)"
read -p "Continue? [y/N] " yn
[[ "$yn" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

AMI_ID=$(_aws ec2 create-image \
  --instance-id "$INSTANCE_ID" \
  --name "$NAME" \
  --description "AIMS POC warm snapshot — Cosmos NIMs pulled, TRT engines cached" \
  --tag-specifications \
    "ResourceType=image,Tags=[{Key=Project,Value=${PROJECT_TAG}}]" \
    "ResourceType=snapshot,Tags=[{Key=Project,Value=${PROJECT_TAG}}]" \
  --query ImageId --output text)

echo "    AMI=$AMI_ID — waiting for image to become available (10–20 min)..."
_aws ec2 wait image-available --image-ids "$AMI_ID"
_save_state WARM_AMI_ID "$AMI_ID"

echo
echo "AMI $AMI_ID is ready. To restore later:"
echo "  1. Terminate the broken instance"
echo "  2. aws ec2 run-instances --image-id $AMI_ID --instance-type $INSTANCE_TYPE ..."
echo "  3. Reattach EIP $EIP_ADDR"
