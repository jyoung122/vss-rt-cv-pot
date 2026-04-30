#!/usr/bin/env bash
# SSI AIMS — VM bootstrap.
#
# Targets a clean Ubuntu 22.04 / 24.04 host (Brev or otherwise) and installs
# everything the prod compose stack needs:
#   - Docker Engine + Compose v2 plugin
#   - NVIDIA Container Toolkit (host driver must already be present)
#   - NGC CLI (for sample-video and model downloads)
#
# Usage:
#   ./scripts/vm_setup.sh             # install + validate (default)
#   ./scripts/vm_setup.sh install     # install only
#   ./scripts/vm_setup.sh validate    # validate only (no installs)
#
# Idempotent — re-running is safe. Requires sudo for installs.
# After install completes, log out and back in (or `newgrp docker`) so the
# docker group membership takes effect for the current shell.

set -euo pipefail

# ── colors ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_CYN=$'\033[36m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_CYN=""; C_DIM=""; C_RST=""
fi

log()    { echo "${C_CYN}==>${C_RST} $*"; }
ok()     { echo "  ${C_GRN}✓${C_RST} $*"; }
warn()   { echo "  ${C_YEL}!${C_RST} $*"; }
fail()   { echo "  ${C_RED}✗${C_RST} $*"; }
section(){ echo; echo "${C_CYN}━━━ $* ━━━${C_RST}"; }

FAILS=0
note_fail(){ FAILS=$((FAILS+1)); fail "$@"; }

# ── detect ───────────────────────────────────────────────────────────────────
if [[ ! -r /etc/os-release ]]; then
  echo "Cannot read /etc/os-release — unsupported host." >&2
  exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  warn "This script is tested on Ubuntu. Detected: ${ID:-unknown} ${VERSION_ID:-?}."
  warn "Continuing, but you may need to adapt the package commands."
fi

UBUNTU_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-jammy}}"
ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"

# ── installers ───────────────────────────────────────────────────────────────
install_base() {
  section "Base packages"
  sudo apt-get update -y
  sudo apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg lsb-release git jq unzip
  ok "base packages present"
}

install_docker() {
  section "Docker Engine + Compose plugin"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "docker + compose plugin already installed ($(docker --version))"
  else
    sudo install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      sudo chmod a+r /etc/apt/keyrings/docker.gpg
    fi
    echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo apt-get update -y
    sudo apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    ok "docker installed"
  fi

  # Brev artifact: docker daemon http-proxy pointing at a non-existent host.
  if [[ -f /etc/systemd/system/docker.service.d/http-proxy.conf ]]; then
    warn "Found Brev http-proxy.conf for docker daemon — removing (known to break image pulls)"
    sudo rm -f /etc/systemd/system/docker.service.d/http-proxy.conf
    sudo systemctl daemon-reload
    sudo systemctl restart docker
  fi

  if ! id -nG "$USER" | grep -qw docker; then
    sudo usermod -aG docker "$USER"
    warn "Added $USER to docker group — log out / back in (or run 'newgrp docker') to use docker without sudo."
  else
    ok "$USER already in docker group"
  fi
}

install_nvidia_toolkit() {
  section "NVIDIA Container Toolkit"
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    note_fail "nvidia-smi not found — install the NVIDIA driver before running this script (Brev GPU instances ship with it; bare VMs do not)."
    return 0
  fi
  if dpkg -s nvidia-container-toolkit >/dev/null 2>&1; then
    ok "nvidia-container-toolkit already installed"
  else
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    sudo apt-get update -y
    sudo apt-get install -y --no-install-recommends nvidia-container-toolkit
    sudo nvidia-ctk runtime configure --runtime=docker
    sudo systemctl restart docker
    ok "nvidia-container-toolkit installed and docker runtime configured"
  fi
}

install_ngc_cli() {
  section "NGC CLI"
  if command -v ngc >/dev/null 2>&1; then
    ok "ngc already installed ($(ngc --version 2>/dev/null | head -1))"
    return 0
  fi
  local tmp
  tmp="$(mktemp -d)"
  log "Downloading NGC CLI…"
  curl -fsSL "https://api.ngc.nvidia.com/v2/resources/nvidia/ngc-apps/ngc_cli/versions/3.41.4/files/ngccli_linux.zip" \
    -o "$tmp/ngccli_linux.zip"
  unzip -q "$tmp/ngccli_linux.zip" -d "$tmp"
  sudo install -m 0755 "$tmp/ngc-cli/ngc" /usr/local/bin/ngc
  rm -rf "$tmp"
  ok "ngc installed → /usr/local/bin/ngc"
  warn "Run 'ngc config set' once to authenticate (org=nvidia, key from NGC console)."
}

# ── validators ───────────────────────────────────────────────────────────────
validate() {
  section "Validation"
  FAILS=0

  if command -v docker >/dev/null 2>&1; then
    ok "docker: $(docker --version)"
  else
    note_fail "docker not on PATH"
  fi

  if docker compose version >/dev/null 2>&1; then
    ok "compose plugin: $(docker compose version --short 2>/dev/null || docker compose version)"
  else
    note_fail "docker compose plugin missing"
  fi

  if docker info >/dev/null 2>&1; then
    ok "docker daemon reachable from this user"
  else
    note_fail "cannot talk to docker daemon (missing group membership? try 'newgrp docker' or re-login)"
  fi

  if command -v nvidia-smi >/dev/null 2>&1; then
    local gpu
    gpu="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)"
    [[ -n "$gpu" ]] && ok "nvidia-smi: $gpu" || note_fail "nvidia-smi present but no GPU reported"
  else
    note_fail "nvidia-smi missing — install host NVIDIA driver"
  fi

  if dpkg -s nvidia-container-toolkit >/dev/null 2>&1; then
    ok "nvidia-container-toolkit installed"
  else
    note_fail "nvidia-container-toolkit not installed"
  fi

  if docker info 2>/dev/null | grep -q "Runtimes:.*nvidia"; then
    ok "docker has nvidia runtime"
  else
    warn "docker does not list nvidia runtime — GPU passthrough may fail"
  fi

  log "Smoke test: GPU visible from a container…"
  if docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L >/dev/null 2>&1; then
    ok "GPU reachable from inside docker"
  else
    warn "GPU smoke test failed — fine if driver/toolkit just installed and docker not yet restarted in this shell."
  fi

  if command -v ngc >/dev/null 2>&1; then
    ok "ngc on PATH"
    if ngc config current >/dev/null 2>&1; then
      ok "ngc already configured"
    else
      warn "ngc installed but not configured — run 'ngc config set'"
    fi
  else
    note_fail "ngc not on PATH"
  fi

  log "Port availability (3000, 8080, 6379, 8081, 30000)…"
  for port in 3000 8080 6379 8081 30000; do
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}\$"; then
      warn "port $port is in use — compose stack will conflict"
    fi
  done

  echo
  if (( FAILS == 0 )); then
    echo "${C_GRN}Validation passed.${C_RST}"
  else
    echo "${C_RED}Validation finished with ${FAILS} failure(s).${C_RST}"
    return 1
  fi
}

next_steps() {
  section "Next steps"
  cat <<EOF
1. ${C_DIM}# log out / back in once so docker group membership takes effect${C_RST}
   newgrp docker

2. ${C_DIM}# NGC auth (org=nvidia, paste your API key when prompted)${C_RST}
   ngc config set
   echo "\$NGC_CLI_API_KEY" | docker login nvcr.io -u '\$oauthtoken' --password-stdin

3. ${C_DIM}# repo config${C_RST}
   cp .env.example .env   ${C_DIM}# edit NGC_CLI_API_KEY, HOST_IP, DATA_DIR${C_RST}
   chmod +x deepstream/init/ds-start.sh

4. ${C_DIM}# sample videos${C_RST}
   ngc registry resource download-version nvidia/vss-developer/dev-profile-sample-data:3.0.0
   mkdir -p data/videos
   tar -xf dev-profile-sample-data_v3.0.0/dev-profile-sample-data.tar.gz -C data/videos/

5. ${C_DIM}# bring up the stack${C_RST}
   docker compose up -d
   docker compose logs -f vss-rt-cv   ${C_DIM}# wait ~3-5 min for first TRT engine build${C_RST}

See README.md for the full walk-through.
EOF
}

# ── entrypoint ───────────────────────────────────────────────────────────────
main() {
  local cmd="${1:-all}"
  case "$cmd" in
    install)
      install_base
      install_docker
      install_nvidia_toolkit
      install_ngc_cli
      ;;
    validate)
      validate
      ;;
    all)
      install_base
      install_docker
      install_nvidia_toolkit
      install_ngc_cli
      validate || true
      next_steps
      ;;
    *)
      echo "Usage: $0 [install|validate|all]" >&2
      exit 2
      ;;
  esac
}

main "$@"
