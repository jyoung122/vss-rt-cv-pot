# Shared config — sourced by all aims-poc scripts.
# Edit these values before running anything else.

export AWS_REGION="us-west-2"
export PROJECT_TAG="aims-poc"

# Instance
export INSTANCE_TYPE="g6e.xlarge"         # single-host GPU: full AIMS stack (1× L40S 48 GB, 4 vCPU, 32 GB RAM)
export ROOT_VOLUME_GB=500
export KEY_PAIR_NAME="aims-poc"          # must already exist in EC2 → Key Pairs (us-west-2)

# AMI: Deep Learning OSS Nvidia Driver AMI (Ubuntu 22.04) — NVIDIA drivers + container toolkit pre-installed.
# Resolved at launch time via name filter (Amazon owner).
export AMI_NAME_FILTER="Deep Learning OSS Nvidia Driver AMI GPU PyTorch*Ubuntu*22.04*"

# Networking — leave subnet blank to auto-pick the default-VPC public subnet in AZ a
export SUBNET_ID=""
export VPC_ID=""

# Access — your IP for SSH access. Run:  curl -s ifconfig.me
export OPERATOR_CIDR="173.95.148.102/32"   # rotate via SG if your ISP changes IP

# Schedule (operator-local, no UTC math)
export SCHEDULE_TIMEZONE="America/New_York"
export SCHEDULE_START_CRON="cron(0 9 * * ? *)"   # 09:00 ET daily
export SCHEDULE_STOP_CRON="cron(0 20 * * ? *)"   # 20:00 ET daily

# Derived/runtime — written by 01-launch.sh, read by other scripts
export STATE_FILE="$(dirname "${BASH_SOURCE[0]}")/.poc-state"

_load_state() {
  [ -f "$STATE_FILE" ] && set -a && . "$STATE_FILE" && set +a || true
}
_save_state() {
  local key="$1" val="$2"
  touch "$STATE_FILE"
  grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" || true
  echo "${key}=${val}" >> "${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

_require() {
  local var="$1"
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set. Edit 00-config.sh." >&2
    exit 1
  fi
}

_aws() { aws --region "$AWS_REGION" "$@"; }
