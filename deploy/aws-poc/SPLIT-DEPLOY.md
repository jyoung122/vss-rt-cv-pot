# Split deployment — AWS edge + Brev GPU box

Reference for the "AWS = edge, Brev = full stack" architecture (Split A).
Covers every change made to get the stack running across two hosts, in the order it needs to happen.

## Architecture

```
┌────────────────────────────────┐         ┌──────────────────────────────────┐
│       AWS EC2 t3.small         │  Tail-  │       Brev L40S 48GB             │
│       us-west-2                │  scale  │       (Crusoe l40s-48gb.1x)      │
│  ────────────────────────────  │ ◄────► │  ──────────────────────────────  │
│  • Caddy (TLS, public URL)     │ tailnet │  • Full docker-compose stack    │
│  • Tailscale client            │   IP    │  • Tailscale client              │
│                                │         │  • Frontend, Backend, Redis,     │
│  Public DNS:                   │         │    Postgres, Cosmos NIM,         │
│  aims.synch-solutions.com      │         │    NVStreamer, SDR, vss-rt-cv,   │
│  → 35.167.72.186 (EIP)         │         │    Kong, Auth, Storage, Studio   │
│                                │         │                                  │
│  cost: ~$15/mo always-on       │         │  cost: ~$1.74/hr × 11h/day = ~$574 │
└────────────────────────────────┘         └──────────────────────────────────┘
```

---

## 1. AWS edge box — code/config changes

### 1a. `deploy/aws-poc/00-config.sh`

Changed from GPU instance to t3.small:

```bash
export AWS_REGION="us-west-2"
export INSTANCE_TYPE="t3.small"            # was g6e.xlarge — no GPU quota needed
export ROOT_VOLUME_GB=20                   # was 500 — Caddy needs almost nothing
export AMI_NAME_FILTER="ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"   # was DLAMI
```

### 1b. `deploy/aws-poc/01-launch.sh`

AMI lookup owner changed from Amazon to Canonical, added arch filter:

```bash
AMI_ID=$(_aws ec2 describe-images \
  --owners 099720109477 \                                          # Canonical
  --filters "Name=name,Values=${AMI_NAME_FILTER}" \
            "Name=state,Values=available" \
            "Name=architecture,Values=x86_64" \
  --query 'reverse(sort_by(Images, &CreationDate))[0].ImageId' \
  --output text)
```

SG description must be ASCII (no em-dash): `"AIMS POC - temporary, delete after 30 days"`.

### 1c. `deploy/aws-poc/user-data.sh` — completely rewritten

The original built a GPU stack on AWS. New one installs only Docker + Tailscale + Caddy:

```bash
#!/bin/bash
set -euxo pipefail
exec > >(tee -a /var/log/aims-edge-bootstrap.log) 2>&1

TS_AUTHKEY="<tskey-auth-...>"          # generated at https://login.tailscale.com/admin/settings/keys
PUBLIC_HOSTNAME="aims.synch-solutions.com"
GPU_HOST="aims-poc-gpu"                # Tailscale MagicDNS name of the Brev box

# 1. Docker engine
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 2. Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --auth-key="${TS_AUTHKEY}" --hostname=aims-poc-edge --accept-routes --accept-dns=true --ssh=false

# 3. Caddy config
mkdir -p /opt/caddy
cat > /opt/caddy/Caddyfile <<CADDY
${PUBLIC_HOSTNAME} {
	encode zstd gzip
	request_body {
		max_size 10GB
	}

	# Unauthenticated direct routes
	@direct path /healthz
	reverse_proxy @direct ${GPU_HOST}:8080

	# Everything else: Next.js. Its middleware injects the Supabase JWT for
	# /api/* and /ws/* before its server-side rewrites proxy to the backend.
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

# 4. systemd unit
cat > /etc/systemd/system/aims-edge.service <<UNIT
[Unit]
Description=AIMS edge (Caddy reverse proxy)
After=docker.service tailscaled.service network-online.target
Requires=docker.service
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
```

**Critical: Caddyfile routes only `/healthz` directly to backend.** Everything else (including `/api/*`) goes through Next.js so middleware can inject the Supabase Bearer token. The original Caddyfile that routed `/api/*` directly to backend caused 401s on every authenticated API call.

**Caddyfile syntax:** `request_body { max_size 10GB }` must be multi-line, not single-line. Caddy parser rejects same-line `{` … `}`.

---

## 2. AWS-side ops changes

### 2a. Route 53 hosted zone

```bash
aws route53 create-hosted-zone --name aims.synch-solutions.com \
  --caller-reference "aims-poc-$(date +%s)" \
  --hosted-zone-config "Comment=AIMS POC subdomain - delete after 30 days,PrivateZone=false"
aws route53 change-tags-for-resource --resource-type hostedzone --resource-id <Z…> \
  --add-tags "Key=Project,Value=aims-poc"
```

A record after EC2 is up:

```json
{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{
  "Name":"aims.synch-solutions.com.","Type":"A","TTL":60,
  "ResourceRecords":[{"Value":"35.167.72.186"}]}}]}
```

### 2b. MSP NS delegation

Parent zone is MSP-managed WordPress. One ticket adds 4 NS records on `synch-solutions.com` pointing the `aims` label at the four `awsdns-*` nameservers from Route 53. After that, all DNS for `aims.synch-solutions.com` is managed in Route 53 without further MSP involvement.

---

## 3. Brev GPU box — bootstrap

Create:

```bash
brev create aims-poc --type l40s-48gb.1x
```

After it boots, run a bootstrap script (over `brev exec aims-poc @bootstrap.sh`) that does:

1. Install Tailscale, `tailscale up --auth-key=... --hostname=aims-poc-gpu`
2. `docker login nvcr.io` with the NGC API key
3. **Copy `/root/.docker/config.json` to `/home/ubuntu/.docker/config.json`** — pulls run as `ubuntu`, login was sudo'd. Without this, NGC pulls 401 even though login succeeded.
4. `git clone https://github.com/jyoung122/vss-rt-cv-pot.git /opt/aims`
5. Stage initial `.env` (will be replaced in next step)

Then push your local working `.env`:

```bash
brev copy .env aims-poc:/opt/aims/.env.imported
```

---

## 4. `.env` changes on Brev (vs your local dev `.env`)

```bash
# Override these on the Brev box:
HOST_IP=<brev internal IP>                  # ip route get 1.1.1.1 | awk '{print $7;exit}'
DATA_DIR=/data                              # was ./data (relative — wrong on Brev)
VLM_ENABLED=true                            # POC actually exercises Cosmos
COMPOSE_PROFILES=gpu                        # enables cosmos service
KONG_HTTP_PORT=8001                         # avoid collision with cosmos:8000 host bind
NEXT_PUBLIC_SUPABASE_URL=http://kong:8000   # was http://localhost:8000 — middleware uses docker DNS
PERCEPTION_TAG=3.1.0                        # not 2.4.0 if you guessed
NVSTREAMER_TAG=3.1.0
SDR_TAG=3.1.0
```

Everything else (`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `MINIO_ROOT_*`, `POSTGRES_PASSWORD`, etc.) comes from your local `.env` as-is.

---

## 5. `docker-compose.yml` change (committed to repo)

The `frontend` service needed build args **and** runtime envs. `NEXT_PUBLIC_*` are inlined into the Next.js bundle at build time — runtime env alone won't override them. But the Dockerfile only sets `ENV NEXT_PUBLIC_*` in the `builder` stage, so server-side code in the `runner` stage reads them as `undefined` unless also injected at runtime.

```yaml
  frontend:
    build:
      context: ./frontend
      args:
        NEXT_PUBLIC_SUPABASE_URL: ${NEXT_PUBLIC_SUPABASE_URL:-http://kong:8000}
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ${ANON_KEY}
        NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL:-https://aims.synch-solutions.com}
        NEXT_PUBLIC_WS_URL: ${NEXT_PUBLIC_WS_URL:-wss://aims.synch-solutions.com}
    container_name: vss-frontend
    ports:
      - "3000:3000"
    environment:
      NEXT_PUBLIC_LOG_LEVEL: ${NEXT_PUBLIC_LOG_LEVEL:-INFO}
      NEXT_PUBLIC_LOG_FORMAT: ${NEXT_PUBLIC_LOG_FORMAT:-json}
      NEXT_PUBLIC_SERVICE_NAME: aims-frontend
      NEXT_PUBLIC_SUPABASE_URL: ${NEXT_PUBLIC_SUPABASE_URL:-http://kong:8000}
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ${ANON_KEY}
      BACKEND_URL: http://backend:8080
      SUPABASE_INTERNAL_URL: http://kong:8000
```

**Why `http://kong:8000` not the public URL:**
- The browser uses `window.location.origin` (the public URL) regardless — see [frontend/src/lib/supabase/client.ts](../../frontend/src/lib/supabase/client.ts).
- The server (middleware) uses `NEXT_PUBLIC_SUPABASE_URL` directly. Setting it to the public URL makes server-side `getUser()` round-trip through DNS → Caddy → Tailscale → Next.js → Kong, which is slow and breaks if any link flakes.
- Setting it to `kong:8000` keeps server-side traffic on the docker network. Browser is unaffected because of the `window.location.origin` fallback.

**Build cache trap:** Docker may reuse a cached layer with the previous build arg value. Use `docker compose build --no-cache frontend` when changing build args, or `docker compose pull` after a fresh CI build.

---

## 6. Post-deploy fixups (one-time on Brev)

Run after `docker compose up` so the supabase init has happened at least once:

### 6a. Set supabase admin role passwords

The `supabase/postgres` image creates `supabase_auth_admin`, `supabase_storage_admin`, `authenticator` **without passwords**. You can't `ALTER USER` as `postgres` (they're reserved roles) — must use `supabase_admin`:

```bash
brev exec aims-poc "cd /opt/aims && source .env && \
  docker exec -e PGPASSWORD=\"\$POSTGRES_PASSWORD\" supabase-db psql -U supabase_admin -d postgres -c \
  \"ALTER ROLE supabase_auth_admin WITH PASSWORD '\$POSTGRES_PASSWORD'; \
    ALTER ROLE supabase_storage_admin WITH PASSWORD '\$POSTGRES_PASSWORD'; \
    ALTER ROLE authenticator WITH PASSWORD '\$POSTGRES_PASSWORD';\" && \
  docker restart supabase-auth supabase-storage vss-backend"
```

This is also documented in the repo's main [README.md](../../README.md) troubleshooting section.

### 6b. TrafficCamNet model (still pending in this deploy)

`vss-rt-cv` will restart-loop until the model is at `/data/models/trafficcamnet_transformer/`:

```bash
# locally (NGC CLI required)
~/repos/ngc-cli/ngc registry model download-version \
  "nvidia/tao/trafficcamnet_transformer_lite:deployable_resnet50_v2.0" \
  --dest /tmp/trafficcamnet

# push to Brev
brev exec aims-poc "sudo mkdir -p /data/models/trafficcamnet_transformer && sudo chown ubuntu:ubuntu /data/models/trafficcamnet_transformer"
brev copy /tmp/trafficcamnet/ aims-poc:/data/models/trafficcamnet_transformer/

# restart rt-cv
brev exec aims-poc "cd /opt/aims && docker compose -f docker-compose.yml -f docker-compose.supabase.yml --profile gpu up -d --force-recreate vss-rt-cv"
```

If NGC's archive nests under a versioned folder, flatten so `*.onnx` lands directly at `/data/models/trafficcamnet_transformer/`.

---

## 7. Bring-up order

1. Add Brev credits at https://www.brev.dev/settings/billing
2. `brev create aims-poc --type l40s-48gb.1x` (~7 min)
3. Bootstrap Brev box (Tailscale, NGC login, repo clone, `.env` import + fixups) — Section 3 + 4
4. Pull images: `docker compose -f docker-compose.yml -f docker-compose.supabase.yml --profile gpu pull` (~15-20 min, ~80 GB)
5. Bring up stack: `docker compose -f docker-compose.yml -f docker-compose.supabase.yml --profile gpu up -d`
6. Run post-deploy fixups (Section 6a) — set supabase role passwords; restart auth/storage/backend
7. Run `01-launch.sh` from the workstation — creates AWS edge t3.small, EIP, SG (Section 1)
8. Create Route 53 hosted zone (Section 2a), send MSP the NS delegation request (Section 2b), add the A record after the EIP is known
9. Wait for MSP to apply NS records (one ticket, may take hours)
10. Wait for `dig +short NS aims.synch-solutions.com` to return the 4 awsdns servers
11. Caddy on the AWS box auto-provisions LE cert once DNS resolves
12. Smoke: `curl https://aims.synch-solutions.com/healthz` returns `{"status":"ok"}`
13. Stage TrafficCamNet model (Section 6b) — fixes vss-rt-cv restart loop
14. Browser test: signup, login, dashboard loads, video upload works

---

## 8. Key facts (this deployment)

| | Value |
|---|---|
| Public URL | https://aims.synch-solutions.com |
| AWS EIP | 35.167.72.186 |
| AWS region | us-west-2 |
| AWS instance | t3.small |
| AWS tailnet | `aims-poc-edge` (100.73.171.12) |
| Brev instance | `aims-poc` (Crusoe l40s-48gb.1x) |
| Brev tailnet | `aims-poc-gpu` (100.70.226.123) |
| Route 53 zone | Z089462436O5NGSGXVPS9 |
| AWS IAM user | aims-poc-deployer |
| Project tag | `Project=aims-poc` (everywhere) |
| State file | `deploy/aws-poc/.poc-state` |

---

## 9. What did not work (and why)

- **GPU on AWS** — `Running On-Demand G and VT instances` quota was 0 for new account; multiple appeals didn't get auto-approved. Pivoted to Brev L40S.
- **`network_mode: service:redis`** in the SDR container forced same-host colocation of sdr/redis/perception. Means we can't split the perception pipeline across hosts — they all live on the Brev box. AWS hosts only the edge.
- **`/api/*` direct to backend through Caddy** — bypassed Next.js middleware that injects the Supabase Bearer token. All authenticated API calls 401'd. Caddy now only short-circuits `/healthz`.
- **Build args without runtime env** — Next.js inlines `NEXT_PUBLIC_*` at build time but server-side modules read them via `process.env` at runtime. Dockerfile sets ENV in `builder` stage only. Solution: set both build arg and runtime environment.
- **Build cache** — `docker compose build` reuses cached layers even when build args change. Use `--no-cache` after build-arg edits.
- **Reserved supabase roles** — `postgres` user is NOT the superuser; `supabase_admin` is. Reserved roles can only be ALTERed by superuser.
- **NGC docker login as root vs pull as ubuntu** — credentials went to `/root/.docker/config.json`, pulls ran as `ubuntu`, pulled 401. Fix: copy creds to `/home/ubuntu/.docker/`.

---

## 10. Teardown when POC ends

1. `./99-teardown.sh` (AWS resources, type `destroy`)
2. `brev delete aims-poc` (kills GPU box billing)
3. `brev delete aims` (unused A100, if you don't need it)
4. Email MSP: remove NS records for `aims` from parent zone
5. Delete IAM user `aims-poc-deployer` (see snippet in this conversation/repo history)
6. Rotate Tailscale API key, NGC API key
7. Cost Explorer check next day: `Project=aims-poc` daily spend → $0
