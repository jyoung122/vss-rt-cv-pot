# AWS POC Runbook — 30-day deploy

Single-host GPU EC2, Caddy TLS, daily 9a–8p ET shutdown. Tear down on day 30.

- **Instance:** `g6e.2xlarge` (1× L40S 48 GB, 8 vCPU, 64 GB RAM)
- **AMI:** Deep Learning OSS Nvidia Driver AMI GPU PyTorch — Ubuntu 22.04 (NVIDIA drivers + container toolkit pre-installed)
- **Disk:** 500 GB gp3 root
- **Region:** `us-west-2` (Oregon) — lowest-latency AWS region with `g6e` availability for an Arizona audience
- **DNS:** subdomain delegated to Route 53 via NS records on the parent zone (parent zone is MSP-managed WordPress)
- **TLS:** Caddy auto Let's Encrypt
- **Schedule:** start 09:00 ET, stop 20:00 ET, every day (operator in EST; demo audience in AZ → covers 7a–6p MST, full AZ business day)
- **Estimated cost:** ~$790 over 30 days

---

## 1. Pre-flight

- [ ] AWS account + IAM user with EC2/Route53/EventBridge access
- [ ] Subdomain decision: `<NAME>.<DOMAIN>` (e.g. `aims-poc.oakridgeautomation.com`)
- [ ] SSH keypair imported to EC2 in `us-west-2`
- [ ] NGC API key with `nvcr.io/nvidia/vss-core/*` access
- [ ] OpenAI key (only if `VLM_PROVIDER=openai`; not needed since Cosmos is in scope)
- [ ] **DNS delegation submitted to MSP** — see Section 1a. Do this first; the MSP turnaround is the long pole.

---

## 1a. DNS delegation (do this first — MSP turnaround is the long pole)

The parent domain is on a WordPress site managed by an MSP. We delegate just the subdomain to Route 53 so we own DNS for the POC without going through the MSP for every change.

1. Route 53 → Hosted zones → **Create hosted zone**
   - Domain: `aims-poc.<domain>`
   - Type: Public
   - Cost: ~$0.50/mo, prorated
2. Note the 4 NS records AWS assigns (e.g. `ns-123.awsdns-XX.com.`, etc.).
3. **Email the MSP** (template):

   > Hi — for a 30-day POC we're hosting `aims-poc.<yourdomain>` on AWS. Please add these NS records on the parent zone so we can manage that subdomain:
   >
   > ```
   > aims-poc   NS   ns-XXX.awsdns-XX.com.
   > aims-poc   NS   ns-XXX.awsdns-XX.net.
   > aims-poc   NS   ns-XXX.awsdns-XX.org.
   > aims-poc   NS   ns-XXX.awsdns-XX.co.uk.
   > ```
   >
   > These can be removed after `<date+30>`. Thanks.

4. Verify propagation (usually 15 min – 2 hr):
   ```bash
   dig +short NS aims-poc.<domain>
   ```
   Once you see the AWS nameservers, you're delegated and can manage everything else yourself.
5. The A record itself is created later in Section 2 step 3.

---

## 2. Launch instance (console, ~10 min)

1. EC2 → Launch instance
   - Name: `aims-poc`
   - AMI: search "Deep Learning OSS Nvidia Driver" → Ubuntu 22.04 variant
   - Instance type: `g6e.2xlarge`
   - Keypair: existing
   - Network: default VPC, public subnet, **enable auto-assign public IP**
   - Security group `aims-poc-sg`:
     - 22/tcp from your IP
     - 80/tcp from 0.0.0.0/0 (Caddy ACME challenge)
     - 443/tcp from 0.0.0.0/0
   - Storage: **500 GB gp3, 3000 IOPS, 125 MB/s**
   - User data: paste `user-data.sh` from this folder, after replacing `__NGC_API_KEY__`
2. Allocate Elastic IP → associate with instance
3. Route 53 → hosted zone `aims-poc.<domain>` (created in Section 1a) → create A record at the apex (leave name field blank) → EIP. TTL 60.
4. Wait ~3 min, then SSH: `ssh -i key.pem ubuntu@<EIP>`

---

## 3. First-boot bring-up (~25 min, mostly NGC pulls)

User-data already cloned the repo to `/opt/aims` and ran `docker login nvcr.io`. Finish manually:

```bash
cd /opt/aims
sudo -u ubuntu cp .env.example .env
sudo -u ubuntu nano .env
```

Set in `.env`:
```bash
NGC_CLI_API_KEY=<key>
HOST_IP=<EIP>
DATA_DIR=/data
VLM_PROVIDER=cosmos
VLM_ENABLED=true
COMPOSE_PROFILES=gpu
PUBLIC_HOSTNAME=aims-poc.<domain>
POSTGRES_PASSWORD=<random-32-char>
```

Bring it up (Cosmos profile pulls both 2B and 8B NIM images — ~60 GB, 15–20 min):

```bash
docker compose --profile gpu pull
docker compose --profile gpu up -d
docker compose -f docker-compose.yml -f deploy/aws-poc/docker-compose.caddy.yml up -d caddy
docker compose logs -f vss-rt-cv  # wait for "Starting DeepStream perception pipeline..."
```

Verify TRT engine cached: `ls /data/models/` should show `.engine` files after first frame.

---

## 4. Smoke test

- [ ] `https://aims-poc.<domain>` loads with valid LE cert (no warnings)
- [ ] Upload a sample video from `data/videos/`
- [ ] Timeline scrubber renders detection events
- [ ] Detail page shows tracks
- [ ] Cosmos VLM validation fires on a clip (check backend logs for `vlm_provider=cosmos`)
- [ ] Both NIMs report ready: `docker compose ps` shows healthy `cosmos-2b` and `cosmos-8b`

---

## 5. Snapshot (insurance)

After smoke passes:

```
EC2 console → Instances → aims-poc → Actions → Image and templates → Create image
  Name: aims-poc-warm-<YYYYMMDD>
  No reboot: unchecked (clean snapshot)
```

This AMI captures pulled NIM images, TRT engines, Postgres state. Restore = launch new instance from this AMI, reattach EIP, done in ~5 min.

---

## 6. Daily schedule (one-time setup)

EventBridge Scheduler (console → Amazon EventBridge → Schedules):

For both schedules below, set **Timezone: `America/New_York`** so DST is handled automatically and the cron values never need to change.

**Start schedule**
- Name: `aims-poc-start`
- Cron: `cron(0 9 * * ? *)`  (09:00 ET, every day)
- Timezone: `America/New_York`
- Target: AWS API → EC2 → `StartInstances` → instance ID
- Flexible window: off

**Stop schedule**
- Name: `aims-poc-stop`
- Cron: `cron(0 20 * * ? *)`  (20:00 ET, every day)
- Timezone: `America/New_York`
- Target: AWS API → EC2 → `StopInstances` → instance ID

> Demo audience is in AZ (MST, no DST). 9a–8p ET = 6a/7a–5p/6p MST depending on DST → covers the full AZ business day in both halves of the year.

After scheduled start, the systemd unit `aims.service` (installed by user-data) runs `docker compose up -d` automatically. Bring-up is ~2 min from cached state.

---

## 7. Daily ops

- **Logs:** `docker compose logs -f <service>`
- **Health:** `docker compose ps` — all should be `healthy` or `running`
- **GPU:** `nvidia-smi` — expect ~25–35 GB VRAM used (DeepStream + 2B + 8B)
- **Disk:** `df -h /` — alarm at 80%. Uploads accumulate in `/data/videos/`.
- **Restart everything clean:** `docker compose --profile gpu down && docker compose --profile gpu up -d`

---

## 8. Teardown checklist (day 30)

In order:

- [ ] Export anything worth keeping (`pg_dump`, `/data/videos/`, screenshots) → S3 or local
- [ ] EventBridge Scheduler → delete `aims-poc-start` and `aims-poc-stop`
- [ ] EC2 → terminate `aims-poc` instance
- [ ] EC2 → release Elastic IP (otherwise charged $3.60/mo idle)
- [ ] EC2 → delete the 500 GB volume (auto-deleted on terminate if root, but verify)
- [ ] EC2 → AMIs → deregister `aims-poc-warm-*` and delete underlying snapshots
- [ ] Route 53 → delete the `aims-poc.<domain>` hosted zone (also removes the A record)
- [ ] Email MSP: "POC complete, please remove the NS records for `aims-poc` from the parent zone"
- [ ] EC2 → delete security group `aims-poc-sg`
- [ ] Cost Explorer next day: confirm `$0` daily spend tagged to this POC

**The biggest "oops" bills come from orphan EBS snapshots and unattached EIPs. Check both.**

---

## Files in this folder

- `RUNBOOK.md` — this file
- `user-data.sh` — EC2 first-boot script (clone repo, install compose plugin, NGC login, install systemd unit)
- `Caddyfile` — reverse proxy config for the subdomain
- `docker-compose.caddy.yml` — overlay adding the Caddy sidecar
- `aims.service` — systemd unit that runs compose on boot
