#!/usr/bin/env bash
# Create EventBridge schedules to start (09:00 ET) and stop (20:00 ET) the instance.
# Uses America/New_York timezone so DST is handled automatically.

set -euo pipefail
cd "$(dirname "$0")"
. ./00-config.sh
_load_state

_require INSTANCE_ID

ACCOUNT_ID=$(_aws sts get-caller-identity --query Account --output text)
ROLE_NAME="${PROJECT_TAG}-scheduler-role"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "==> IAM role for EventBridge Scheduler"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  TRUST=$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
)
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" \
    --tags "Key=Project,Value=${PROJECT_TAG}" >/dev/null
  POLICY=$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ec2:StartInstances","ec2:StopInstances"],"Resource":"arn:aws:ec2:${AWS_REGION}:${ACCOUNT_ID}:instance/${INSTANCE_ID}"}]}
JSON
)
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "${PROJECT_TAG}-ec2-start-stop" \
    --policy-document "$POLICY"
  echo "    waiting for IAM role propagation..."
  sleep 10
fi
echo "    ROLE_ARN=$ROLE_ARN"

_create_schedule() {
  local name="$1" cron="$2" action="$3"
  local target_arn="arn:aws:scheduler:::aws-sdk:ec2:${action}"
  local input="{\"InstanceIds\":[\"${INSTANCE_ID}\"]}"

  if _aws scheduler get-schedule --name "$name" >/dev/null 2>&1; then
    _aws scheduler update-schedule --name "$name" \
      --schedule-expression "$cron" \
      --schedule-expression-timezone "$SCHEDULE_TIMEZONE" \
      --flexible-time-window "Mode=OFF" \
      --target "{\"Arn\":\"${target_arn}\",\"RoleArn\":\"${ROLE_ARN}\",\"Input\":\"$(echo "$input" | sed 's/"/\\"/g')\"}" >/dev/null
    echo "    updated $name"
  else
    _aws scheduler create-schedule --name "$name" \
      --schedule-expression "$cron" \
      --schedule-expression-timezone "$SCHEDULE_TIMEZONE" \
      --flexible-time-window "Mode=OFF" \
      --target "{\"Arn\":\"${target_arn}\",\"RoleArn\":\"${ROLE_ARN}\",\"Input\":\"$(echo "$input" | sed 's/"/\\"/g')\"}" >/dev/null
    echo "    created $name"
  fi
}

echo "==> Schedules"
_create_schedule "${PROJECT_TAG}-start" "$SCHEDULE_START_CRON" "startInstances"
_create_schedule "${PROJECT_TAG}-stop"  "$SCHEDULE_STOP_CRON"  "stopInstances"

echo
echo "Schedules active. Instance will start ${SCHEDULE_START_CRON} and stop ${SCHEDULE_STOP_CRON} (${SCHEDULE_TIMEZONE})."
