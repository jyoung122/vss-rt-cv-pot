#!/usr/bin/env bash
# Launch the POC instance: SG, EIP, EC2 with 500GB gp3, attach EIP.
# Idempotent: re-running reuses tagged resources.
#
# Prereqs:
#   - aws CLI configured (aws configure)
#   - 00-config.sh edited (KEY_PAIR_NAME, OPERATOR_CIDR)
#   - user-data.sh edited with NGC_API_KEY and REPO_URL

set -euo pipefail
cd "$(dirname "$0")"
. ./00-config.sh
_load_state

_require KEY_PAIR_NAME
_require OPERATOR_CIDR

echo "==> Resolving DLAMI image id"
AMI_ID="${AMI_ID:-}"
if [ -z "$AMI_ID" ]; then
  AMI_ID=$(_aws ec2 describe-images \
    --owners 099720109477 \
    --filters "Name=name,Values=${AMI_NAME_FILTER}" "Name=state,Values=available" "Name=architecture,Values=x86_64" \
    --query 'reverse(sort_by(Images, &CreationDate))[0].ImageId' \
    --output text)
fi
[ "$AMI_ID" != "None" ] && [ -n "$AMI_ID" ] || { echo "Could not resolve AMI"; exit 1; }
echo "    AMI_ID=$AMI_ID"

echo "==> Resolving default VPC + public subnet (if not set)"
[ -n "$VPC_ID" ] || VPC_ID=$(_aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text)
[ -n "$SUBNET_ID" ] || SUBNET_ID=$(_aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=default-for-az,Values=true" \
  --query 'Subnets[0].SubnetId' --output text)
echo "    VPC_ID=$VPC_ID  SUBNET_ID=$SUBNET_ID"

echo "==> Security group"
SG_ID=$(_aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=${PROJECT_TAG}-sg" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(_aws ec2 create-security-group \
    --group-name "${PROJECT_TAG}-sg" \
    --description "AIMS POC - temporary, delete after 30 days" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=${PROJECT_TAG}}]" \
    --query 'GroupId' --output text)
  _aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions \
      "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${OPERATOR_CIDR},Description=ssh-operator}]" \
      "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=acme-http}]" \
      "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=https}]"
fi
echo "    SG_ID=$SG_ID"
_save_state SG_ID "$SG_ID"

echo "==> EC2 instance"
INSTANCE_ID=$(_aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=${PROJECT_TAG}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")
if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  [ -f user-data.sh ] || { echo "user-data.sh missing"; exit 1; }
  grep -q "__NGC_API_KEY__" user-data.sh && { echo "Edit user-data.sh: replace __NGC_API_KEY__ and __OWNER__"; exit 1; }
  INSTANCE_ID=$(_aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_PAIR_NAME" \
    --subnet-id "$SUBNET_ID" \
    --security-group-ids "$SG_ID" \
    --associate-public-ip-address \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=${ROOT_VOLUME_GB},VolumeType=gp3,DeleteOnTermination=true}" \
    --user-data "file://user-data.sh" \
    --tag-specifications \
      "ResourceType=instance,Tags=[{Key=Project,Value=${PROJECT_TAG}},{Key=Name,Value=${PROJECT_TAG}}]" \
      "ResourceType=volume,Tags=[{Key=Project,Value=${PROJECT_TAG}}]" \
    --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
    --query 'Instances[0].InstanceId' --output text)
  echo "    Launched $INSTANCE_ID — waiting for running state..."
  _aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
fi
echo "    INSTANCE_ID=$INSTANCE_ID"
_save_state INSTANCE_ID "$INSTANCE_ID"

echo "==> Elastic IP"
EIP_ALLOC=$(_aws ec2 describe-addresses \
  --filters "Name=tag:Project,Values=${PROJECT_TAG}" \
  --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "None")
if [ "$EIP_ALLOC" = "None" ] || [ -z "$EIP_ALLOC" ]; then
  EIP_ALLOC=$(_aws ec2 allocate-address --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Project,Value=${PROJECT_TAG}}]" \
    --query 'AllocationId' --output text)
fi
EIP_ADDR=$(_aws ec2 describe-addresses --allocation-ids "$EIP_ALLOC" --query 'Addresses[0].PublicIp' --output text)
EIP_ASSOC=$(_aws ec2 describe-addresses --allocation-ids "$EIP_ALLOC" --query 'Addresses[0].AssociationId' --output text)
if [ "$EIP_ASSOC" = "None" ] || [ -z "$EIP_ASSOC" ]; then
  _aws ec2 associate-address --allocation-id "$EIP_ALLOC" --instance-id "$INSTANCE_ID" >/dev/null
fi
echo "    EIP=$EIP_ADDR  EIP_ALLOC=$EIP_ALLOC"
_save_state EIP_ALLOC "$EIP_ALLOC"
_save_state EIP_ADDR "$EIP_ADDR"

cat <<EOF

======================================================================
 POC instance is up.

   Instance:  $INSTANCE_ID
   Public IP: $EIP_ADDR
   SSH:       ssh -i ~/.ssh/${KEY_PAIR_NAME}.pem ubuntu@${EIP_ADDR}

 Next:
   1. Create the Route 53 hosted zone for your subdomain (Section 1a of RUNBOOK)
   2. Add an A record pointing it to ${EIP_ADDR}
   3. SSH in, fill /opt/aims/.env, then: sudo systemctl start aims
   4. ./02-schedule.sh   (after smoke test passes)
   5. ./03-snapshot.sh   (after smoke test passes)
======================================================================
EOF
