#!/usr/bin/env bash
# korea-jobs reader — one-shot setup on a fresh Ubuntu VM (Oracle Always Free).
# Installs Docker, fetches the reader code, prepares .env, and starts it 24/7.
#
# SAFETY: no secret values live in this script. You paste them into .env on the
# VM only (rule #1). Run this script twice:
#   1st run  -> installs everything, creates an empty .env, then stops.
#   (you edit .env and paste your 5 secret values)
#   2nd run  -> builds and starts the reader (auto-restart, 24/7).

set -euo pipefail

# Where the reader code is fetched from. Set by the operator before running:
#   export REPO_URL="https://github.com/<owner>/korea-jobs-collector.git"
# (for a private repo, embed a read-only token: https://<TOKEN>@github.com/...)
REPO_URL="${REPO_URL:-}"
APP_DIR="$HOME/korea-collector"

log() { printf '\n==> %s\n' "$*"; }

# --- 0. small swap so a 1 GB micro VM survives the Docker build -----------------
if ! sudo swapon --show | grep -q .; then
  log "Creating a 2 GB swap file (helps the 1 GB micro VM build without OOM)..."
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# --- 1. Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo systemctl enable --now docker
fi

# --- 2. reader code -------------------------------------------------------------
if [ -z "$REPO_URL" ] && [ ! -d "$APP_DIR/.git" ]; then
  echo "!! REPO_URL is not set. Run:  export REPO_URL=\"https://github.com/.../korea-jobs-collector.git\"  then re-run." >&2
  exit 1
fi
if [ -d "$APP_DIR/.git" ]; then
  log "Updating reader code..."
  git -C "$APP_DIR" pull --ff-only || true
else
  log "Fetching reader code..."
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# --- 3. .env (secrets pasted here on the VM, never through chat) -----------------
if [ ! -f .env ]; then
  cp .env.example .env
  cat <<'MSG'

  Created .env from the template. Now paste your 5 secret values:

      nano .env

  Fill these lines (values come from your local collector/.env):
      TG_API_ID, TG_API_HASH, TG_SESSION, INGEST_URL, INGEST_SECRET

  Save in nano: Ctrl+O, Enter, then Ctrl+X.
  Then run this script one more time to start the reader.

MSG
  exit 0
fi

# --- 4. run 24/7 ----------------------------------------------------------------
log "Building & starting the reader (auto-restart, 24/7)..."
sudo docker compose up -d --build

log "Started. Useful commands:"
echo "    sudo docker compose logs -f      # watch the reader live"
echo "    sudo docker compose restart      # restart it"
echo "    sudo docker compose down         # stop it"
