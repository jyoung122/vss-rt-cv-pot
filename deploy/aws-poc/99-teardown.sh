#!/usr/bin/env bash
# Tear down ALL POC resources tagged Project=aims-poc in $AWS_REGION.
# Idempotent. Asks once for confirmation.

set -euo pipefail
cd "$(dirname "$0")"
. ./00-config.sh
_load_state

cat <<EOF
This will delete EVERY resource in $AWS_REGION tagged Project=${PROJECT_TAG}:
  - EC2 instance
  - Elastic IP
  - Security group
  - EventBridge schedules
  - IAM role for the scheduler
  - AMIs (warm snapshots) + their underlying EBS snapshots
  - Route 53 hosted zone for the subdomain (if you set HOSTED_ZONE_ID below)

This is NOT REVERSIBLE.
EOF
read -p "Type 'destroy' to proceed: " confirm
[ "$confirm" = "destroy" ] || { echo "Aborted."; exit 1; }

ACCOUNT_ID=$(_aws sts get-caller-identity --query Account --output text)

echo "==> Deleting EventBridge schedules"
for s in "${PROJECT_TAG}-start" "${PROJECT_TAG}-stop"; do
  _aws scheduler delete-schedule --name "$s" 2>/dev/null && echo "    deleted $s" || true
done

echo "==> Deleting IAM scheduler role"
ROLE_NAME="${PROJECT_TAG}-scheduler-role"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  for p in $(aws iam list-role-policies --role-name "$ROLE_NAME" --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$p"
  done
  aws iam delete-role --role-name "$ROLE_NAME"
  echo "    deleted $ROLE_NAME"
fi

echo "==> Deregistering AMIs + deleting underlying snapshots"
for ami in $(_aws ec2 describe-images --owners "$ACCOUNT_ID" \
    --filters "Name=tag:Project,Values=${PROJECT_TAG}" \
    --query 'Images[].ImageId' --output text); do
  SNAPS=$(_aws ec2 describe-images --image-ids "$ami" \
    --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text)
  _aws ec2 deregister-image --image-id "$ami"
  echo "    deregistered $ami"
  for snap in $SNAPS; do
    _aws ec2 delete-snapshot --snapshot-id "$snap" 2>/dev/null && echo "    deleted snapshot $snap" || true
  done
done

echo "==> Terminating instances"
INSTANCES=$(_aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=${PROJECT_TAG}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$INSTANCES" ]; then
  _aws ec2 terminate-instances --instance-ids $INSTANCES >/dev/null
  echo "    terminating: $INSTANCES — waiting..."
  _aws ec2 wait instance-terminated --instance-ids $INSTANCES
fi

echo "==> Releasing Elastic IPs"
for alloc in $(_aws ec2 describe-addresses \
    --filters "Name=tag:Project,Values=${PROJECT_TAG}" \
    --query 'Addresses[].AllocationId' --output text); do
  ASSOC=$(_aws ec2 describe-addresses --allocation-ids "$alloc" --query 'Addresses[0].AssociationId' --output text)
  if [ "$ASSOC" != "None" ] && [ -n "$ASSOC" ]; then
    _aws ec2 disassociate-address --association-id "$ASSOC" || true
  fi
  _aws ec2 release-address --allocation-id "$alloc"
  echo "    released $alloc"
done

echo "==> Deleting security groups"
for sg in $(_aws ec2 describe-security-groups \
    --filters "Name=tag:Project,Values=${PROJECT_TAG}" \
    --query 'SecurityGroups[].GroupId' --output text); do
  _aws ec2 delete-security-group --group-id "$sg" && echo "    deleted $sg" || true
done

# Route 53 hosted zone — HOSTED_ZONE_ID is loaded from .poc-state.
if [ -n "${HOSTED_ZONE_ID:-}" ]; then
  echo "==> Deleting Route 53 records + hosted zone $HOSTED_ZONE_ID"
  _aws route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
    --query 'ResourceRecordSets[?Type!=`NS` && Type!=`SOA`]' --output json > /tmp/r53.json
  CHANGES=$(jq '{Changes: [.[] | {Action: "DELETE", ResourceRecordSet: .}]}' /tmp/r53.json)
  if [ "$(echo "$CHANGES" | jq '.Changes | length')" -gt 0 ]; then
    _aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "$CHANGES" >/dev/null
  fi
  _aws route53 delete-hosted-zone --id "$HOSTED_ZONE_ID" >/dev/null
fi

rm -f "$STATE_FILE"

cat <<EOF

Teardown complete. Verify in Cost Explorer tomorrow that daily spend tagged
Project=${PROJECT_TAG} drops to \$0.

Don't forget:
  - Email the MSP to remove the NS records for the subdomain
  - Check the AWS console manually for any untagged orphans
EOF
