#!/bin/bash
set -euo pipefail

# Runs archive-wiki-api directly under systemd, cloned from the private
# bkc-archive-wiki repo via a read-only deploy key (see
# deploy_key_secret_name in variables.tf). No Docker: this app has no
# published container image, so this mirrors its own documented native
# deployment (api/README.md) rather than inventing one.
#
# Idempotent throughout (checked by existence, not by a first-boot flag) so
# a metadata-only apply that just resets the instance doesn't redo the
# clone/build/user-creation work every time it re-runs — same convention as
# chroma-vm/mongo-vm's startup scripts.

REPO_DIR=/srv/archive-wiki
APP_USER=archive-wiki
SSH_DIR=/home/$APP_USER/.ssh
DEPLOY_KEY_PATH=$SSH_DIR/id_ed25519

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs git
fi

if ! id -u $APP_USER >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin $APP_USER
fi

# Deploy key + known_hosts, so this script's clone (as this same user) can
# reach GitHub over SSH with no interactive host-key prompt and no key
# material outside this user's own home directory.
mkdir -p "$SSH_DIR"
cat > "$DEPLOY_KEY_PATH" <<'EOF'
${deploy_key}
EOF
chmod 700 "$SSH_DIR"
chmod 600 "$DEPLOY_KEY_PATH"
ssh-keyscan -t ed25519 github.com >> "$SSH_DIR/known_hosts" 2>/dev/null
chown -R $APP_USER:$APP_USER "$SSH_DIR"

GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY_PATH -o UserKnownHostsFile=$SSH_DIR/known_hosts"

# /srv isn't writable by a non-root user, so the clone below (run as
# $APP_USER) can't create $REPO_DIR itself — same pattern as mongo-vm's
# DB_DIR/BACKUP_DIR chown before it drops to uid 999. Always run (not
# guarded), so it's a no-op on a later boot rather than something only the
# first-clone block below can rely on having happened.
mkdir -p "$REPO_DIR"
chown $APP_USER:$APP_USER "$REPO_DIR"

if [ ! -d "$REPO_DIR/.git" ]; then
  # --no-checkout: leaves the working tree empty, so this step's own
  # idempotency check (.git existing) can't be satisfied by a clone that
  # never actually got to check out or build anything. The checkout+build
  # below has its own, separate guard for exactly that reason.
  sudo -u $APP_USER env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" \
    git clone --no-checkout git@github.com:berkmancenter/bkc-archive-wiki.git "$REPO_DIR"
  # core.sshCommand persists this repo's SSH identity, so a future manual
  # `git pull`/`fetch` (as this same user, e.g. over an IAP SSH session)
  # doesn't need the env var repeated.
  sudo -u $APP_USER git -C "$REPO_DIR" config core.sshCommand "$GIT_SSH_COMMAND"
fi

if [ ! -d "$REPO_DIR/api/dist" ]; then
  # Guarded on the BUILD output, not .git: under set -euo pipefail, a bad
  # app_ref (a typo, or a SHA not yet pushed) fails the checkout below and
  # aborts this boot. Guarding on .git instead (as a plain `git clone` +
  # checkout would leave you checking) would make every later boot see the
  # clone already present and skip straight past checkout AND the npm
  # build, starting the service against an empty, unbuilt working tree
  # with nothing to ever retry it. Guarding on api/dist means a failed
  # checkout or build here is retried in full on the next boot instead.
  #
  # Pins the content and code this boot builds/runs to a specific,
  # reviewed commit (var.app_ref) instead of whatever main's tip happens
  # to be the moment this VM is created/replaced. Nothing else updates
  # this checkout afterward -- picking up a new commit (content or code)
  # means a fresh deploy to a new app_ref, same as bot-media-server-vm's
  # own web_server_image_tag convention (see that variable's description).
  sudo -u $APP_USER git -C "$REPO_DIR" checkout "${app_ref}"

  sudo -u $APP_USER bash -c "cd $REPO_DIR/api && npm ci && npm run build"
fi

cat > "$REPO_DIR/api/.env" <<EOF
PORT=${archive_api_port}
ARCHIVE_API_TOKEN=${archive_api_token}
EOF
chown $APP_USER:$APP_USER "$REPO_DIR/api/.env"
chmod 600 "$REPO_DIR/api/.env"

cat > /etc/systemd/system/archive-wiki-api.service <<EOF
[Unit]
Description=bkc archive wiki api service
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

WorkingDirectory=$REPO_DIR/api
ExecStart=/usr/bin/node $REPO_DIR/api/dist/index.js

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
systemctl enable --now archive-wiki-api

# No in-place content-refresh cron: content and code are both pinned to
# app_ref and both only move via a fresh, reviewed deploy (a new app_ref
# plus a targeted `terraform apply -replace` of this instance -- see that
# variable's description). A scheduled GitHub Actions workflow
# (llm_engine-infra) is expected to drive that automatically, nightly,
# only when bkc-archive-wiki's main has actually moved -- accepting the
# brief restart that causes even for a content-only change, in exchange
# for one deploy path instead of two separate ones with different cadences
# and different blast radii.
#
# Ops Agent: ships this VM's CPU/memory/disk metrics to Cloud Monitoring.
# Requires the service_account block in main.tf; without it the agent runs
# but every write 403s silently. Idempotent: install is skipped once
# already present.
#
# Logging is NOT the agent's default behavior here, despite
# StandardOutput=journal/StandardError=journal on the unit above: confirmed
# live (llm_engine-infra's docs/operations.md, 2026-09-29) that Ops Agent's
# default install does not forward a plain systemd service's journal to
# Cloud Logging at all -- only OS-level noise (CRON, systemd unit
# lifecycle, oslogin) showed up, zero lines from archive-wiki-api itself,
# ever, over a 30-day check. bot-media-server-vm hit this same gap and
# fixed it by writing an explicit config.yaml with a systemd_journald
# receiver instead of assuming the default install covers it -- same fix
# applied here.
#
# One receiver ingests the WHOLE journal (systemd_journald doesn't filter
# by unit at the receiver level), landing under one fixed logName,
# archive_wiki_journal -- same OS noise plus this app's own lines,
# together. A log-reading script narrows to just the app by filtering
# client-side on jsonPayload._SYSTEMD_UNIT="archive-wiki-api.service",
# same idea as bot-media-server-vm's own log script.
#
# A custom config.yaml REPLACES Ops Agent's default configuration
# wholesale, not just the section you name -- the metrics pipeline
# (hostmetrics, which is what actually produces
# agent.googleapis.com/memory|disk/percent_used for this module's
# dashboard widgets) gets dropped too unless this file restates it.
# Confirmed live on bot-media-server-vm: a config.yaml with only a
# logging: section silently zeroed out its memory/disk widgets.
#
# Install BEFORE writing this file, not after: the package ships its own
# default config.yaml, and a file already sitting at this path when dpkg
# first installs it gets treated as a locally-modified conffile -- dpkg
# stops to prompt (Y/I/N/O/D/Z) interactively, which has no stdin/TTY here
# and fails outright, taking down the rest of this script with it.
# Confirmed live on bot-media-server-vm (2026-09-30). Writing our own
# config.yaml only after install means the package lays down its own
# default untouched, then we overwrite it -- no pre-existing file for dpkg
# to treat as a conflict.
#
# Restarted unconditionally every boot (not just "already installed"), so
# a startup-script change (e.g. after a fresh terraform apply -replace)
# always takes effect -- a fresh install's own postinst only starts the
# agent with whatever config.yaml existed at that moment (the package
# default, since ours isn't written yet), so it still needs this restart
# to pick up ours.
if ! dpkg -s google-cloud-ops-agent >/dev/null 2>&1; then
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
fi

mkdir -p /etc/google-cloud-ops-agent
cat > /etc/google-cloud-ops-agent/config.yaml <<'EOF'
metrics:
  receivers:
    hostmetrics:
      type: hostmetrics
      collection_interval: 60s
  service:
    pipelines:
      default_pipeline:
        receivers: [hostmetrics]

logging:
  receivers:
    archive_wiki_journal:
      type: systemd_journald
  service:
    pipelines:
      archive_wiki_pipeline:
        receivers: [archive_wiki_journal]
EOF

systemctl restart google-cloud-ops-agent
