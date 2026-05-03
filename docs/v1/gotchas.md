# AIMS — Deployment & Dev Gotchas

Things that have bitten us during cold deploys or rebuilds. Skim this before a fresh setup.

---

## Image build

### `frontend` build fails with `cannot replace to directory ... node_modules/... with file`

**Cause.** The frontend Dockerfile does `COPY --from=deps /app/node_modules ./node_modules` then `COPY . .`. Without a `.dockerignore`, the host's `frontend/node_modules` (left over from local `npm install`) overlays the builder stage's modules and triggers a file-vs-directory collision.

**Fix.** `frontend/.dockerignore` excludes `node_modules`, `.next`, `.env*`. Already in tree — don't delete it.

**Symptom in logs.**
```
ERROR: cannot replace to directory /var/lib/docker/overlay2/.../merged/app/node_modules/@tailwindcss/postcss with file
target frontend: failed to solve: ...
```

### `frontend` build fails on `useSearchParams() should be wrapped in a suspense boundary`

**Cause.** Next.js 15 refuses to statically prerender any route whose render tree calls `useSearchParams()` outside a `<Suspense>` boundary. `<AppHeader>` lives in the root layout and reads `useSearchParams()` (for the `/live` view toggle), so the implicit `/_not-found` page — which still renders the layout — fails the static export.

**Fix.** `frontend/src/app/layout.tsx` wraps `<AppHeader />` in `<Suspense fallback={...}>`. Already in tree as of post-Phase-10 — don't unwrap it.

**Symptom in logs.**
```
⨯ useSearchParams() should be wrapped in a suspense boundary at page "/404".
Error occurred prerendering page "/_not-found".
target frontend: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1
```

---

## Model staging

### `vss-rt-cv` exits trying to download TrafficCamNet from NGC

**Cause.** `deepstream/init/ds-start.sh` calls `ngc registry model download-version` if the ONNX is missing. NGC CLI's signed-URL handler 403s on the redirect to `xfiles.ngc.nvidia.com`, so the download silently fails.

**Fix.** Pre-stage the ONNX on the host via bearer-token REST before `docker compose up`:

```bash
set -a; source .env; set +a
curl -fL -H "Authorization: Bearer $NGC_CLI_API_KEY" \
  -o data/models/trafficcamnet_transformer/resnet50_trafficcamnet_rtdetr.fp16.onnx \
  "https://api.ngc.nvidia.com/v2/org/nvidia/team/tao/models/trafficcamnet_transformer_lite/versions/deployable_resnet50_v2.0/files/resnet50_trafficcamnet_rtdetr.fp16.onnx"
```

84 MB. After this, `ds-start.sh` skips the NGC download and DeepStream builds the TRT engine on first run.

### `vss-rt-cv` crash-loops with `failed to serialize cuda engine to file` after a 3-min compile

**Cause.** The `vss-rt-cv` container runs as `uid=1000(triton-server)`. The host `data/models/trafficcamnet_transformer/` directory inherits the cloning user's UID (e.g. `1002`) with mode 755. The compile succeeds in memory but TRT can't write the `.engine` to disk → pipeline fails → container restarts → recompiles → fails again. Each loop burns ~3 GPU-minutes.

**Symptom in logs.**
```
WARN ... failed to serialize cude engine to file: /data/models/.../*.engine
WARNING: ... Serialize engine failed because of file path: ... opened error
ERROR from source: Not found
App run failed
```

**Fix.** `chmod -R 777 data/models` before bringing the stack up, or `chown -R 1000:1000`. The named-volume migration in Phase 3 burn item 6 will moot this.

### TRT engine cold compile is ~3.5 min and looks like a hang

**Cause.** First `vss-rt-cv` boot per host compiles the `.engine` from the ONNX. There is no progress output during compile.

**Signal it's working.** GPU goes from idle to ~5–15 GB usage in `nvidia-smi`. The `.engine` file appears in `data/models/trafficcamnet_transformer/` when done.

**Persistence.** The `.engine` lives on the host bind-mount `data/models/`, so subsequent restarts skip compilation. Moving to a named volume (day-2 item) would decouple it from the host path.

---

## Stack startup

### Backend logs `asyncpg.exceptions.CannotConnectNowError: the database system is starting up`

**Cause.** Postgres container hasn't finished init when the backend's lifespan startup connects. Compose has no healthcheck-gated `depends_on` yet (Phase 3 burn-list item 5).

**Reality.** Uvicorn restarts and the second attempt succeeds. Not currently fatal but noisy. If startup truly fails, do `docker compose restart backend`.

### Backend logs `Error registering stream with SDR: Temporary failure in name resolution` after upload

**Cause.** The upload handler tries to register the new stream with the `sdr` service via DNS. On cold starts where Docker's embedded DNS hasn't fully propagated, the lookup transiently fails. Observed once during e2e validation (2026-04-30) — did not block detection flow because the perception path doesn't actually depend on SDR registration in upload-only mode.

**Fix.** Currently cosmetic. If we ever re-enable SDR-driven stream switching, this needs a retry-with-backoff. Track under Phase 3 if it persists.

### `current_stream_url.txt` not present → DeepStream falls back to a placeholder RTSP

**Cause.** `ds-start.sh` looks for `/data/videos/current_stream_url.txt`; if absent, the perception config gets `rtsp://nvstreamer:30554/placeholder`. The pipeline fails to construct a source — engine still compiles, but no detections flow.

**Fix.** Trigger a real upload via `POST /api/uploads`. The backend writes `current_stream_url.txt` and restarts the `vss-rt-cv` container via the Docker socket.

---

## Data layout

### `data/videos/` may not exist on a fresh checkout

**Cause.** The directory is created lazily by the upload handler; on a clean clone it's not there.

**Watch out.** If you `brev copy <file> aims:/path/to/data/videos`, brev treats the missing destination as a *filename* and copies your MP4 *as* `data/videos`. Pre-create the directory first, or copy with a trailing slash:

```bash
ssh aims "mkdir -p /home/shadeform/aims/data/videos"
brev copy ./clip.mp4 aims:/home/shadeform/aims/data/videos/
```

---

## Doc drift

### `NGC_API_KEY` vs `NGC_CLI_API_KEY`

`V1_PLAN.md` line 79 lists `NGC_API_KEY`. Real env var name is `NGC_CLI_API_KEY` (matches the NGC CLI convention). `.env.example` is correct.

---

## Cosmos / VLM (Phase 8)

### `aims-cosmos` healthcheck fails for 10–15 minutes on first boot

**Cause.** The NIM container downloads ~15 GB of Cosmos-Reason2-2B weights before the HTTP server starts. The healthcheck polls `/v1/health/ready`; it will return non-200 until the download and model load complete.

**Fix.** Wait. The `start_period: 10m` in the healthcheck prevents the container from being marked unhealthy during this window. Watch progress with `docker logs -f aims-cosmos`.

**Subsequent restarts.** The `aims-cosmos-cache` named volume persists the weights. Subsequent cold starts take ~60 s, not 10–15 min.

### `aims-cosmos` is healthy but `POST /analyze` returns VLM errors

**Cause.** Most likely the Cosmos API rejected the base64 video payload — either the clip is malformed or the API schema differs from the assumed OpenAI-compatible format.

**Diagnosis.**
```bash
docker logs vss-backend | grep "vlm_validator"   # look for the error message
docker logs aims-cosmos                           # look for request errors
```

**Quick workaround.** Set `VLM_ENABLED=false` in `.env` and `docker compose restart backend`. Incidents will be marked `skipped` and the rest of the pipeline continues unaffected.

### `VLM_ENABLED=false` — how to skip Cosmos entirely

The backend handles this gracefully: after rule detection, a single `UPDATE ... SET vlm_status='skipped'` runs and returns immediately. The `aims-cosmos` container can be excluded entirely:

```bash
docker compose up -d --build --scale cosmos=0
```

The UI will show no VLM pills (status `skipped` renders nothing visible).

---

## Compose hygiene

- `restart: unless-stopped` is on every long-running service — good.
- Healthchecks are defined for `redis`, `postgres`, `backend`, and `vss-rt-cv`.
- `redis-commander` removed from prod compose. Use `docker exec vss-redis redis-cli` for ad-hoc inspection.

---

## Fast-path checklist for a cold deploy

1. `frontend/.dockerignore` exists.
2. `.env` populated (`NGC_CLI_API_KEY`, `HOST_IP`, `DATA_DIR=./data`, `NUM_SENSORS=1`, `*_TAG=3.1.0`).
3. `docker login nvcr.io --username '$oauthtoken' --password-stdin <<< $NGC_CLI_API_KEY` succeeded.
4. ONNX pre-staged at `data/models/trafficcamnet_transformer/resnet50_trafficcamnet_rtdetr.fp16.onnx`.
5. `data/videos/` exists as a directory.
6. `docker compose up -d --build` and budget 4–5 min for first boot (image pulls + TRT compile).
