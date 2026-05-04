#!/usr/bin/env bash
# SSI AIMS — NVIDIA driver upgrade.
#
# Brings the host driver up to the minimum required by docs/v1/deploy/deploy.md
# (≥ 580). Apt-only path: assumes the cuda apt repo is configured (true for
# vm_setup.sh users and stock Brev/Shadeform Ubuntu 22.04 images). Runfile
# installs are not supported — refuse and bail.
#
# By default the script preserves the kernel-module flavor that is currently
# installed (open vs proprietary). A host on nvidia-driver-NNN-open ends up on
# nvidia-driver-${TARGET_DRIVER}-open. Override with DRIVER_FLAVOR.
#
# Usage:
#   ./scripts/update_driver.sh             # check + install + print reboot hint
#   ./scripts/update_driver.sh check       # report only, no changes
#   ./scripts/update_driver.sh install     # apt install only, no reboot
#   ./scripts/update_driver.sh recover     # finish a half-applied install (iU state)
#   ./scripts/update_driver.sh verify      # post-reboot sanity check
#
# Env overrides:
#   TARGET_DRIVER=585                # default 580
#   DRIVER_FLAVOR=open|proprietary   # default = match what is currently installed
#
# Idempotent — exits clean if already ≥ TARGET_DRIVER on the requested flavor.
# Does NOT reboot. Prints the command and lets you choose the moment.

set -euo pipefail

TARGET_DRIVER="${TARGET_DRIVER:-580}"
DRIVER_FLAVOR="${DRIVER_FLAVOR:-auto}"

# ── colors (match vm_setup.sh) ───────────────────────────────────────────────
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

# ── helpers ──────────────────────────────────────────────────────────────────
# Returns the running driver's major branch as an integer, or 0 if nvidia-smi
# can't talk to the kernel module (no driver, or post-install/pre-reboot
# userspace/kmod mismatch — note that NVML errors land on stdout, not stderr).
current_branch() {
  command -v nvidia-smi >/dev/null 2>&1 || { echo 0; return; }
  local out
  if ! out="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null)"; then
    echo 0; return
  fi
  echo "$out" | head -1 | awk -F. '{print $1}'
}

current_full() {
  command -v nvidia-smi >/dev/null 2>&1 || { echo "(none)"; return; }
  local out
  if ! out="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null)"; then
    echo "(nvidia-smi error — driver/kmod mismatch, likely pre-reboot)"; return
  fi
  echo "$out" | head -1
}

# All installed nvidia-driver-NNN[-open] packages, one per line. Captured
# once into a string so callers can grep against it with a here-string —
# avoids SIGPIPE on `grep -q` closing the pipe under `set -o pipefail`.
installed_driver_packages() {
  dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 2>/dev/null \
    | awk '$1 == "ii" && $2 ~ /^nvidia-driver-[0-9]+(-open)?$/ {print $2}' || true
}

# Distinguish apt vs runfile install. Runfile leaves /usr/bin/nvidia-uninstall
# (the apt packages do not), and does not register an nvidia-driver-NNN package.
is_runfile_install() {
  [[ -x /usr/bin/nvidia-uninstall ]] || return 1
  [[ -z "$(installed_driver_packages)" ]]
}

compose_stack_up() {
  command -v docker >/dev/null 2>&1 || return 1
  [[ "$(docker ps --filter label=com.docker.compose.project -q 2>/dev/null | wc -l)" -gt 0 ]]
}

# Detect installed driver flavor from dpkg state. Cross-flavor switches are
# what cause libnvidia-extra-NNN to overwrite-conflict with libnvidia-gl-NNN,
# so the script defaults to matching the existing flavor.
detect_flavor() {
  local pkgs
  pkgs="$(installed_driver_packages)"
  if grep -qE '^nvidia-driver-[0-9]+-open$' <<<"$pkgs"; then
    echo "open"
  elif grep -qE '^nvidia-driver-[0-9]+$' <<<"$pkgs"; then
    echo "proprietary"
  else
    echo "none"
  fi
}

resolved_flavor() {
  if [[ "$DRIVER_FLAVOR" == "auto" ]]; then
    local f
    f="$(detect_flavor)"
    [[ "$f" == "none" ]] && f="proprietary"   # fresh host → proprietary default
    echo "$f"
  else
    echo "$DRIVER_FLAVOR"
  fi
}

resolved_package() {
  local flavor; flavor="$(resolved_flavor)"
  case "$flavor" in
    open)        echo "nvidia-driver-${TARGET_DRIVER}-open" ;;
    proprietary) echo "nvidia-driver-${TARGET_DRIVER}" ;;
    *) fail "unknown DRIVER_FLAVOR=${DRIVER_FLAVOR}" >&2; return 1 ;;
  esac
}

# Sibling packages from the old branch that don't get auto-removed by apt's
# metapackage replacement. libnvidia-extra-NNN owns files that newer
# libnvidia-gl-NNN wants to write (causes the dpkg overwrite error);
# nvidia-fabricmanager-NNN leaves a dead systemd unit that whines on boot.
old_branch_stragglers() {
  local target_branch="$1"
  { dpkg -l 2>/dev/null || true; } \
    | awk '$1 == "ii" {print $2}' \
    | sed 's/:amd64$//; s/:i386$//' \
    | grep -E '^(libnvidia-extra-|libnvidia-common-|nvidia-firmware-|nvidia-fabricmanager-)[0-9]+$' \
    | grep -vE -- "-${target_branch}\$" || true
}

# ── steps ────────────────────────────────────────────────────────────────────
check() {
  section "Driver status"
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    fail "nvidia-smi not found — no host driver installed"
    return 1
  fi
  local cur full pkg cur_flavor want_flavor
  cur="$(current_branch)"
  full="$(current_full)"
  cur_flavor="$(detect_flavor)"
  want_flavor="$(resolved_flavor)"
  pkg="$(resolved_package)"
  ok "current: branch ${cur} (full ${full}, flavor ${cur_flavor})"
  ok "target:  branch ${TARGET_DRIVER} (package ${pkg}, flavor ${want_flavor})"

  if (( cur >= TARGET_DRIVER )) && [[ "$cur_flavor" == "$want_flavor" ]]; then
    ok "already at or above target on the requested flavor — no upgrade needed"
    return 0
  fi

  # Already-installed-but-not-rebooted: target package is in dpkg state ii but
  # nvidia-smi still reports the old branch (or fails with the NVML mismatch).
  # Don't try to "upgrade" again — point at verify.
  if dpkg -s "${pkg}" >/dev/null 2>&1 && (( cur < TARGET_DRIVER )); then
    warn "${pkg} is installed, but the running kernel still holds the old driver."
    warn "you're between install and reboot. Reboot, then run:"
    warn "    ./scripts/update_driver.sh verify"
    return 0
  fi

  if (( cur < TARGET_DRIVER )); then
    warn "branch upgrade needed: ${cur} → ${TARGET_DRIVER}"
  fi
  if [[ "$cur_flavor" != "none" && "$cur_flavor" != "$want_flavor" ]]; then
    warn "flavor change: ${cur_flavor} → ${want_flavor} (cross-flavor switch — old-branch siblings will be purged)"
  fi

  local stragglers
  stragglers="$(old_branch_stragglers "$TARGET_DRIVER")"
  if [[ -n "$stragglers" ]]; then
    warn "old-branch stragglers found (will be purged before install):"
    echo "$stragglers" | sed 's/^/      /'
  fi

  if is_runfile_install; then
    fail "host appears to use a .run installer (found /usr/bin/nvidia-uninstall, no apt nvidia-driver-NNN package)."
    fail "this script only supports apt-managed drivers. Run 'sudo nvidia-uninstall' first, or upgrade by hand."
    return 1
  fi

  # Surface secure boot — apt-installed kernel modules need MOK enrollment if SB is on.
  if command -v mokutil >/dev/null 2>&1; then
    if mokutil --sb-state 2>/dev/null | grep -qi 'enabled'; then
      warn "Secure Boot is enabled — apt will prompt for a one-time MOK password during install."
      warn "you must reboot, enter the BIOS MOK manager, and enroll the key, or the new driver won't load."
    fi
  fi

  return 2  # caller distinguishes "fine" (0) from "needs work" (2)
}

install_driver() {
  local pkg
  pkg="$(resolved_package)"
  section "Apt install ${pkg}"

  if compose_stack_up; then
    warn "docker compose stack is running."
    warn "the install itself is safe (the live driver kmod stays loaded until reboot),"
    warn "but bring it down before rebooting:"
    warn "    docker compose down"
  fi

  if ! command -v dpkg >/dev/null 2>&1; then
    fail "dpkg missing — not a Debian/Ubuntu host?"
    return 1
  fi

  # DKMS needs headers for every installed kernel it'll build for.
  local kver
  kver="$(uname -r)"
  if ! dpkg -s "linux-headers-${kver}" >/dev/null 2>&1; then
    log "installing linux-headers-${kver} (DKMS needs them)…"
    sudo apt-get install -y --no-install-recommends "linux-headers-${kver}"
  else
    ok "linux-headers-${kver} already present"
  fi

  log "apt-get update…"
  sudo apt-get update -y

  # Pre-purge old-branch siblings before apt-get install. Without this, a
  # cross-flavor switch fails on file-overlap with libnvidia-extra-NNN.
  local stragglers
  stragglers="$(old_branch_stragglers "$TARGET_DRIVER")"
  if [[ -n "$stragglers" ]]; then
    log "purging old-branch stragglers:"
    echo "$stragglers" | sed 's/^/    /'
    # shellcheck disable=SC2086
    sudo apt-get purge -y $stragglers
  fi

  if dpkg -s "${pkg}" >/dev/null 2>&1; then
    ok "${pkg} already installed (driver may load after reboot)"
  else
    log "apt-get install ${pkg} (will conflict-remove the older nvidia-driver metapackage)…"
    sudo apt-get install -y "${pkg}"
    ok "${pkg} installed"
  fi

  # Sanity-check DKMS built modules for the running kernel.
  if command -v dkms >/dev/null 2>&1; then
    if dkms status 2>/dev/null | grep -qE "nvidia[/, ]${TARGET_DRIVER}.*${kver}.*installed"; then
      ok "DKMS module built for kernel ${kver}"
    else
      warn "DKMS does not show an installed nvidia/${TARGET_DRIVER} module for kernel ${kver}."
      warn "check /var/lib/dkms/nvidia/${TARGET_DRIVER}*/build/make.log before rebooting."
    fi
  fi
}

# Recover from a half-applied install (iU packages in dpkg state). Runs
# `apt-get install -f -y` to finish configuration, then sweeps stragglers.
# If apt can't finish, prints the manual fix that worked for us in May 2026.
recover() {
  section "Recover half-applied install"
  local broken
  broken="$(dpkg -l 2>/dev/null | awk '$1 ~ /^i[UFH]/ {print $2}' | tr '\n' ' ')"
  if [[ -z "${broken// /}" ]]; then
    ok "no half-installed packages found"
  else
    warn "half-installed packages:"
    echo "$broken" | tr ' ' '\n' | sed 's/^/    /'
    log "apt-get install -f -y…"
    if ! sudo apt-get install -f -y; then
      fail "apt could not auto-recover. Likely a leftover libnvidia-extra-<old>"
      fail "owning a file the new libnvidia-gl wants. Manual fix:"
      fail "    sudo dpkg --purge libnvidia-extra-<old-branch>"
      fail "    sudo apt-get install -f -y"
      return 1
    fi
    ok "apt finished configuring"
  fi

  # Even when apt is happy, dead old-branch siblings often linger.
  local stragglers
  stragglers="$(old_branch_stragglers "$TARGET_DRIVER")"
  if [[ -n "$stragglers" ]]; then
    log "purging old-branch stragglers:"
    echo "$stragglers" | sed 's/^/    /'
    # shellcheck disable=SC2086
    sudo apt-get purge -y $stragglers
  fi
}

reboot_hint() {
  section "Next: reboot"
  cat <<EOF
The new kernel module is staged but the running kernel still holds the old
driver. To activate ${TARGET_DRIVER}:

  ${C_DIM}# 1. stop the stack so no clip processing is killed mid-pipeline${C_RST}
  docker compose down

  ${C_DIM}# 2. reboot — your SSH/IDE session will drop${C_RST}
  sudo reboot

  ${C_DIM}# 3. after reconnect, verify and bring the stack back up${C_RST}
  ./scripts/update_driver.sh verify
  docker compose up -d
EOF
}

verify() {
  section "Post-install verification"
  local cur
  cur="$(current_branch)"
  if (( cur >= TARGET_DRIVER )); then
    ok "nvidia-smi reports branch ${cur} ($(current_full))"
  else
    fail "nvidia-smi still reports branch ${cur} — reboot pending?"
    return 1
  fi

  if command -v docker >/dev/null 2>&1; then
    log "GPU smoke test from a container (nvidia/cuda:12.4.1-base-ubuntu22.04)…"
    if docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L >/dev/null 2>&1; then
      ok "GPU reachable from inside docker"
    else
      fail "container GPU smoke test failed — check nvidia-container-toolkit (vm_setup.sh validate)"
      return 1
    fi
  else
    warn "docker not installed — skipping container smoke test"
  fi
  echo
  echo "${C_GRN}Driver upgrade verified.${C_RST}"
}

# ── entrypoint ───────────────────────────────────────────────────────────────
main() {
  local cmd="${1:-all}"
  case "$cmd" in
    check)
      check
      ;;
    install)
      check && return 0 || true   # already at target → exit 0
      install_driver
      ;;
    recover)
      recover
      ;;
    verify)
      verify
      ;;
    all)
      local rc=0
      check || rc=$?
      if (( rc == 0 )); then return 0; fi   # already at target
      if (( rc != 2 )); then return "$rc"; fi  # check failed for another reason
      install_driver
      reboot_hint
      ;;
    *)
      echo "Usage: $0 [check|install|recover|verify|all]" >&2
      exit 2
      ;;
  esac
}

main "$@"
