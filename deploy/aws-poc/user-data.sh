#!/bin/bash
# EC2 user-data for the single-host GPU box (full AIMS stack).
# Replace __NGC_API_KEY__ and __OWNER__ (GitHub user/org) before pasting into launch.

set -euxo pipefail
exec > >(tee -a /var/log/aims-bootstrap.log) 2>&1

NGC_API_KEY="__NGC_API_KEY__"
REPO_URL="https://github.com/__OWNER__/vss-rt-cv-pot.git"

# 1. Docker + Compose (DLAMI may already have Docker; install if missing)
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Ensure ubuntu user can run docker without sudo
usermod -aG docker ubuntu || true

# 2. NGC login (as ubuntu so compose pulls work without sudo)
echo "${NGC_API_KEY}" | sudo -u ubuntu docker login nvcr.io -u "\$oauthtoken" --password-stdin
# Also copy creds to root in case of sudo pulls
mkdir -p /root/.docker
cp /home/ubuntu/.docker/config.json /root/.docker/config.json || true

# 3. Clone repo
mkdir -p /opt/aims
chown ubuntu:ubuntu /opt/aims
sudo -u ubuntu git clone "${REPO_URL}" /opt/aims

# 4. Data directory
mkdir -p /data/videos /data/models
chown -R ubuntu:ubuntu /data

# 5. Systemd unit (starts compose on boot/restart)
cp /opt/aims/deploy/aws-poc/aims.service /etc/systemd/system/aims.service
systemctl daemon-reload
systemctl enable aims.service
# Do NOT start it now — operator must fill .env first.

echo "Bootstrap complete. Next: SSH in, fill /opt/aims/.env, then: sudo systemctl start aims"
