#!/bin/bash
# EC2 user-data for the AWS edge box (Split A: AWS = Caddy + TLS only).
# The GPU stack runs on Brev; this box reverse-proxies to it over Tailscale.
# Replace tskey-auth-kVrAB3jeRa11CNTRL-53pwJP5gEnX9BNUNLhYmnXu3YhCW33xJ and aims.synch-solutions.com before pasting into launch.

set -euxo pipefail
exec > >(tee -a /var/log/aims-edge-bootstrap.log) 2>&1

TS_AUTHKEY="tskey-auth-kVrAB3jeRa11CNTRL-53pwJP5gEnX9BNUNLhYmnXu3YhCW33xJ"
PUBLIC_HOSTNAME="aims.synch-solutions.com"
GPU_HOST="aims-poc-gpu"   # Tailscale MagicDNS name of the Brev box

# 1. Docker + Compose
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

# 2. Tailscale
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
tailscale up --auth-key="${TS_AUTHKEY}" --hostname=aims-poc-edge --accept-routes --accept-dns=true --ssh=false || true

# 3. Caddy config and runtime
mkdir -p /opt/caddy
cat > /opt/caddy/Caddyfile <<CADDY
${PUBLIC_HOSTNAME} {
	encode zstd gzip
	request_body { max_size 10GB }

	@api path /api/* /uploads/* /events/* /healthz /ws/*
	reverse_proxy @api ${GPU_HOST}:8080

	reverse_proxy ${GPU_HOST}:3000
}
CADDY

cat > /opt/caddy/docker-compose.yml <<COMPOSE
services:
  caddy:
    image: caddy:2
    container_name: aims-caddy
    restart: unless-stopped
    network_mode: host
    volumes:
      - /opt/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
volumes:
  caddy_data:
  caddy_config:
COMPOSE

# 4. systemd unit for Caddy
cat > /etc/systemd/system/aims-edge.service <<UNIT
[Unit]
Description=AIMS edge (Caddy reverse proxy)
After=docker.service tailscaled.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/caddy
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now aims-edge.service

echo "Edge bootstrap complete. Caddy will reach the GPU box at ${GPU_HOST} via Tailscale."
