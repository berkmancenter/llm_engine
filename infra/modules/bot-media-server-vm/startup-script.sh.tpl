#!/bin/bash
set -euo pipefail

# Runs bot-media-server directly under systemd (no Docker) — same rationale
# as archive-wiki-vm's own module: no published image exists for this
# process, and it's plain TypeScript run via the ts-node/esm loader
# (package.json's "bot-media-server" script), not a compiled build like
# archive-wiki-api's. llm_engine is public, so this clones over plain
# HTTPS — no deploy key, unlike archive-wiki-vm's private bkc-archive-wiki.
#
# Idempotent throughout (checked by existence, not a first-boot flag), same
# convention as archive-wiki-vm/chroma-vm/mongo-vm's startup scripts.
# Deliberately does NOT re-pull/re-checkout on an existing clone: as
# archive-wiki-vm's own refresh-cron comment explains, keeping a running
# app's *code* in sync via a background pull is the wrong tool for an
# actual code release. A code update here is a deliberate
# `terraform apply -replace` on this instance (see main.tf), timed for a
# moment with no active calls — never something that happens silently
# underneath a live meeting bot.

REPO_DIR=/srv/bot-media-server
APP_USER=bot-media-server

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs git
fi

if ! command -v yarn >/dev/null 2>&1; then
  npm install -g yarn
fi

# debian-cloud/debian-12's base image does not ship the gcloud CLI — needed
# below for Secret Manager (app-env) and GCS (Kokoro models).
if ! command -v gcloud >/dev/null 2>&1; then
  apt-get update
  apt-get install -y apt-transport-https ca-certificates gnupg curl
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update
  apt-get install -y google-cloud-cli
fi

if ! id -u $APP_USER >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin $APP_USER
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  # /srv isn't writable by a non-root user, so the clone below (run as
  # $APP_USER) can't create $REPO_DIR itself — same pattern as
  # archive-wiki-vm's REPO_DIR/mongo-vm's DB_DIR chown-before-clone.
  mkdir -p "$REPO_DIR"
  chown $APP_USER:$APP_USER "$REPO_DIR"

  sudo -u $APP_USER git clone https://github.com/berkmancenter/llm_engine.git "$REPO_DIR"
  sudo -u $APP_USER git -C "$REPO_DIR" checkout "${checkout_ref}"

  # Whole-monorepo install: bot-media-server/ has no package.json of its
  # own, it shares the repo root's (see that package's README).
  sudo -u $APP_USER bash -c "cd $REPO_DIR && yarn install --frozen-lockfile"
fi

# Kokoro models: no auto-download in production (bot-media-server/README.md
# — an interrupted first-run download once left a corrupted model file
# that failed opaquely deep inside onnxruntime instead of with a clear
# error). Synced from GCS on every boot rather than gated by existence —
# `rsync` no-ops once the files already match, and this lets a model
# update land on a plain reset without needing a full -replace.
mkdir -p "$REPO_DIR/bot-media-server/models"
gsutil -m rsync -r "gs://${model_bucket_name}" "$REPO_DIR/bot-media-server/models"
chown -R $APP_USER:$APP_USER "$REPO_DIR/bot-media-server/models"

# Runtime config: one blob secret (LLM_ENGINE_USERNAME/PASSWORD — see
# bot-media-server/.env.example for the full set) plus a couple of
# Terraform-known values appended after — same pattern webserver-mig
# already uses for its own app-env secret. Not baked into instance
# metadata: fetched fresh here at boot.
ENV_FILE="$REPO_DIR/bot-media-server/.env"
gcloud secrets versions access latest --secret=${app_env_secret_id} > "$ENV_FILE"
{
  echo "PORT=${bot_media_server_port}"
  echo "LLM_ENGINE_URL=${internal_llm_engine_url}"
  echo "LLM_ENGINE_WS_URL=${internal_llm_engine_ws_url}"
} >> "$ENV_FILE"
chown $APP_USER:$APP_USER "$ENV_FILE"
chmod 600 "$ENV_FILE"

cat > /etc/systemd/system/bot-media-server.service <<EOF
[Unit]
Description=llm_engine bot-media-server
After=network.target
StartLimitIntervalSec=10
StartLimitBurst=5

[Service]
Type=simple
User=$APP_USER
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=NODE_ENV=production

WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/yarn bot-media-server

KillMode=control-group
TimeoutStopSec=5
Restart=always
RestartSec=500ms

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now bot-media-server

# Ops Agent: ships this VM's CPU/memory/disk metrics to Cloud Monitoring.
# Requires the service_account block in main.tf; without it the agent runs
# but every write 403s silently. Idempotent: install is skipped once
# already present.
#
# Logging is NOT the agent's default behavior here — confirmed live against
# archive-wiki-vm (same native-systemd, StandardOutput=journal shape as this
# module), which has run this exact "install with no config.yaml" pattern
# for weeks: Cloud Logging has only OS-level noise for it (CRON, systemd
# unit lifecycle, oslogin) under logs/syslog, zero lines from the app
# itself, ever. Whatever forwards CRON/systemd's own messages to syslog
# doesn't pick up a plain service's stdout the same way. So this module
# writes an explicit config.yaml with a systemd_journald receiver instead of
# assuming the default install covers it — reads the journal directly, not
# dependent on syslog forwarding at all.
#
# One receiver ingests the WHOLE journal (systemd_journald doesn't filter by
# unit at the receiver level), landing under one fixed logName,
# bot_media_server_journal — same OS noise plus this app's own lines,
# together. scripts/bot-media-logs.sh (llm_engine-infra) narrows to just the
# app by filtering client-side on jsonPayload._SYSTEMD_UNIT, same idea as
# webserver-mig's gcplogs-docker-driver logName isolating that app's lines
# from instance noise, just enforced in the query instead of at the source.
#
# Written unconditionally (every boot) and the agent restarted whenever
# already installed, so a startup-script change (e.g. after a fresh
# terraform apply -replace) actually takes effect — install alone only
# picks up config.yaml on its own first start.
mkdir -p /etc/google-cloud-ops-agent
cat > /etc/google-cloud-ops-agent/config.yaml <<'EOF'
logging:
  receivers:
    bot_media_server_journal:
      type: systemd_journald
  service:
    pipelines:
      bot_media_server_pipeline:
        receivers: [bot_media_server_journal]
EOF

if ! dpkg -s google-cloud-ops-agent >/dev/null 2>&1; then
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
else
  systemctl restart google-cloud-ops-agent
fi
