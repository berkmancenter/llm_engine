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

if ! command -v crontab >/dev/null 2>&1; then
  apt-get update
  apt-get install -y cron
  systemctl enable --now cron
fi

if ! id -u $APP_USER >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin $APP_USER
fi

# Deploy key + known_hosts, so both this script's clone and the refresh
# cron's later `git pull` (as this same user) can reach GitHub over SSH
# with no interactive host-key prompt and no key material outside this
# user's own home directory.
mkdir -p "$SSH_DIR"
cat > "$DEPLOY_KEY_PATH" <<'EOF'
${deploy_key}
EOF
chmod 700 "$SSH_DIR"
chmod 600 "$DEPLOY_KEY_PATH"
ssh-keyscan -t ed25519 github.com >> "$SSH_DIR/known_hosts" 2>/dev/null
chown -R $APP_USER:$APP_USER "$SSH_DIR"

GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY_PATH -o UserKnownHostsFile=$SSH_DIR/known_hosts"

if [ ! -d "$REPO_DIR/.git" ]; then
  # /srv isn't writable by a non-root user, so the clone below (run as
  # $APP_USER) can't create $REPO_DIR itself — same pattern as mongo-vm's
  # DB_DIR/BACKUP_DIR chown before it drops to uid 999.
  mkdir -p "$REPO_DIR"
  chown $APP_USER:$APP_USER "$REPO_DIR"

  sudo -u $APP_USER env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" \
    git clone git@github.com:berkmancenter/bkc-archive-wiki.git "$REPO_DIR"
  # core.sshCommand persists this repo's SSH identity, so the refresh
  # cron's plain `git pull` below doesn't need the env var repeated.
  sudo -u $APP_USER git -C "$REPO_DIR" config core.sshCommand "$GIT_SSH_COMMAND"

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

# Keeping content fresh (api/README.md): the wiki content changes daily via
# GitHub Actions pushing to bkc-archive-wiki's main, but the search index
# is only built at process start — so pull + reindex in place rather than
# restart, no dropped requests. 30 7 * * * (UTC, this VM's default tz) is
# the schedule api/README.md itself documents, chosen to land after the
# upstream fetch workflows' latest run (07:05 UTC). No rebuild step here:
# only markdown content changes this way, read straight off disk per
# request — rebuilding is only needed for an actual code release of the
# API itself, done manually (see this module's main.tf).
cat > /etc/cron.d/archive-wiki-refresh <<EOF
30 7 * * * $APP_USER cd $REPO_DIR && git pull --ff-only && curl -fsS -X POST -H "Authorization: Bearer ${archive_api_token}" http://localhost:${archive_api_port}/v1/reindex
EOF
chmod 644 /etc/cron.d/archive-wiki-refresh

# Ops Agent: ships this VM's CPU/memory/disk metrics to Cloud Monitoring and
# forwards journald (including archive-wiki-api's own stdout/stderr, see
# StandardOutput/StandardError above) to Cloud Logging. Requires the
# service_account block in main.tf; without it the agent runs but every
# write 403s silently. Idempotent: skipped once already installed.
if ! dpkg -s google-cloud-ops-agent >/dev/null 2>&1; then
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
fi
