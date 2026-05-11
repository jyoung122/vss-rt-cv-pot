# AIMS POC — Operator Todo List

Last touched 2026-05-11. Infra is up; remaining work is app-config, ops setup, and end-of-POC cleanup.

---

## P0 — Demo blockers (must fix before showing the customer)

- [ ] **Frontend: bake `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` into the build.**
  `https://aims.synch-solutions.com` currently 500s on middleware. Next.js needs `NEXT_PUBLIC_*` at **build time**, not runtime. Either (a) pass as build args in [docker-compose.yml](../../docker-compose.yml) frontend service, or (b) rebuild with the env present.
  Verify: `curl -sI https://aims.synch-solutions.com` returns `200` or `307`, not `500`.

- [ ] **`vss-rt-cv`: get TrafficCamNet model in place.**
  Container is restart-looping with `[ds-start] ERROR: ngc CLI not found`. Options:
  - Pre-stage model to `/data/models/trafficcamnet_transformer/` on the Brev box (`brev copy` or download via NGC CLI on your laptop then push)
  - Install NGC CLI inside the container via a Dockerfile patch
  - Skip TrafficCamNet if RT-DETR alone is enough — patch [`deepstream/init/ds-start.sh`](../../deepstream/init/ds-start.sh)
  Verify: `docker logs vss-rt-cv` shows "Starting DeepStream perception pipeline..."

- [ ] **`supabase-storage`: fix `supabase_storage_admin` password.**
  Storage container restart-looping with `password authentication failed for user "supabase_storage_admin"`. Likely needs an init SQL granting password to that role, or a missing env var the supabase compose expects. Compare against your locally-working supabase-db init.
  Verify: `docker ps` shows `supabase-storage` as `Up (healthy)`.

- [ ] **Smoke test end-to-end after the above.**
  Upload a video at `https://aims.synch-solutions.com`, watch detections appear on the timeline. Click into a detail page. Confirm scrubber works.

---

## P1 — Ops setup (before going live with customer)

- [ ] **Decide AWS edge schedule.** `t3.small` is ~$15/mo always-on. Probably not worth wiring scheduled-stop. If you do want it: edit [`02-schedule.sh`](02-schedule.sh) and run it.

- [ ] **Brev box scheduled stop/start.** Brev has no built-in scheduler. Two options:
  - Cron on your laptop: `0 9 * * * brev start aims-poc; 0 20 * * * brev stop aims-poc` (won't fire if laptop is asleep)
  - Run cron on the AWS edge box itself (always-on) calling Brev API. Need to install brev CLI there and auth.
  - Or just manually `brev start aims-poc` before demos.
  At $1.74/hr × 11h/day × 30d = ~$574 if always-on during work hours; $360 if weekdays only.

- [ ] **AWS warm AMI snapshot.** After the AWS edge is solid (Caddy + Tailscale working), run `./03-snapshot.sh`. Insurance against the t3.small dying or the EIP needing re-association.

- [ ] **MSP confirmation.** Verify the MSP applied the NS records — `dig +short NS aims.synch-solutions.com` should return the four `awsdns-*` nameservers. It currently does (DNS works), so MSP is good. If not, follow up.

---

## P2 — Demo prep

- [ ] **Set lower TTLs on critical DNS** in case you need to swap the EIP mid-demo. Route 53 A record for `aims.synch-solutions.com` is at TTL 60 — good already.

- [ ] **Confirm Cosmos NIM health** once the rt-cv issue is fixed and the VLM path actually runs. `docker logs aims-cosmos` should show model loaded and ready. First-call latency may be high — warm it up before the demo.

- [ ] **Pre-stage demo videos** on the Brev box at `/data/videos/`. Don't risk first-time upload during the demo if it's slow.

- [ ] **Rehearse the demo URL.** Open `https://aims.synch-solutions.com` in an incognito window from a clean network. Click through the whole user flow.

- [ ] **Have a fallback URL ready.** If AWS edge or Caddy dies mid-demo, you can temporarily point DNS straight at the Brev tailnet IP via a public Brev port — keep that backup plan in your back pocket.

---

## P3 — Security hygiene (do before the POC ends)

- [ ] **Rotate the Tailscale API key** you pasted in chat: https://login.tailscale.com/admin/settings/keys
- [ ] **Don't `git add` [user-data.sh](user-data.sh)** — it has the NGC key and the Tailscale auth key embedded. After teardown, revert to the templated `__PLACEHOLDER__` version.
- [ ] **NGC API key** is in [.env](../../.env) and on the Brev box `/opt/aims/.env`. If the chat or repo ever leaks, rotate at the NGC portal.

---

## P4 — End of POC (day 30, 2026-06-10)

- [ ] **Run `./99-teardown.sh`** — handles AWS instance, EIP, SG, AMI, hosted zone, IAM role for scheduler. Type "destroy" to confirm.
- [ ] **`brev delete aims-poc`** — kills the GPU box and stops billing.
- [ ] **`brev delete aims`** — the unused A100 from before, if you don't need it.
- [ ] **Email MSP** to remove the NS records for `aims.synch-solutions.com` from the parent zone.
- [ ] **Delete IAM user** `aims-poc-deployer` (full snippet in the chat history — list/delete access keys, detach policy, delete user).
- [ ] **Rotate** the Tailscale API key, NGC API key, and any other shared secret.
- [ ] **Day-after cost check** in AWS Cost Explorer — verify `Project=aims-poc` spend drops to $0. The most common surprise bill is an orphaned EBS snapshot or unattached EIP that wasn't tagged.

---

## Quick command reference

```bash
# Stack status (Brev)
brev exec aims-poc "docker ps --format 'table {{.Names}}\t{{.Status}}'"

# Restart full stack
brev exec aims-poc "cd /opt/aims && docker compose -f docker-compose.yml -f docker-compose.supabase.yml --profile gpu restart"

# Logs (Brev)
brev exec aims-poc "docker logs <container> --tail 50"

# SSH AWS edge
ssh -i ~/.ssh/aims-poc.pem ubuntu@35.167.72.186

# Caddy restart on AWS
ssh -i ~/.ssh/aims-poc.pem ubuntu@35.167.72.186 "sudo docker restart aims-caddy"

# Stop Brev to save money
brev stop aims-poc

# Start Brev before a demo (~2 min)
brev start aims-poc && sleep 60 && brev exec aims-poc "cd /opt/aims && docker compose -f docker-compose.yml -f docker-compose.supabase.yml --profile gpu up -d"
```

---

## Key facts (don't lose these)

| | Value |
|---|---|
| Public URL | https://aims.synch-solutions.com |
| AWS edge EIP | 35.167.72.186 |
| AWS region | us-west-2 |
| Brev tailnet IP | 100.70.226.123 (`aims-poc-gpu`) |
| AWS tailnet IP | 100.73.171.12 (`aims-poc-edge`) |
| Route 53 zone | `Z089462436O5NGSGXVPS9` |
| AWS IAM user | `aims-poc-deployer` |
| AWS GPU quota request | still open / pending — irrelevant now that we use Brev. Cancel by replying to support case if you don't want it auto-approved later. |
| State file | `deploy/aws-poc/.poc-state` |
