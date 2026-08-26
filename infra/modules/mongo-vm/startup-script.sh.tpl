#!/bin/bash
set -euo pipefail

# Format (only on first boot) and mount the attached persistent disk, then
# run mongod as a Docker container. This VM has no external IP at all, so
# binding to all interfaces only exposes Mongo on the internal VPC network;
# the network module's firewall rule further restricts inbound access to
# web-server-tagged instances only.
#
# The disk holds two sibling directories, not just Mongo's data files:
# db/ (mongod's dbpath) and backups/ (mongodump archives, see the cron job
# below). Both need to live on this disk, not the boot disk, so the
# mongo-vm module's scheduled snapshot policy — which targets this disk —
# captures the dump archives alongside the live data.

DATA_DEVICE="/dev/disk/by-id/google-mongo-data"
MOUNT_POINT="/mnt/mongo-data"
DB_DIR="$MOUNT_POINT/db"
BACKUP_DIR="$MOUNT_POINT/backups"
INITDB_DIR="/opt/mongo-initdb"

mkdir -p "$MOUNT_POINT"
if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then
  mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard "$DATA_DEVICE"
fi
# fstab (with nofail, so a missing/broken disk doesn't hang boot) makes the
# mount survive a reboot; mountpoint -q makes this script itself idempotent
# across re-runs on an already-mounted disk — without it, a second run
# (e.g. after `gcloud compute instances reset`, see main.tf) dies on
# "already mounted" and every command after it never runs, which for the
# docker run below means mongod restarts against an empty directory on the
# boot disk instead of failing loudly.
if ! grep -q "^$DATA_DEVICE " /etc/fstab; then
  echo "$DATA_DEVICE $MOUNT_POINT ext4 discard,defaults,nofail 0 2" >>/etc/fstab
fi
if ! mountpoint -q "$MOUNT_POINT"; then
  mount "$MOUNT_POINT"
fi
mkdir -p "$DB_DIR" "$BACKUP_DIR" "$INITDB_DIR"
chown 999:999 "$DB_DIR" "$BACKUP_DIR" # the mongo image runs as uid 999 internally

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker.io
  systemctl enable --now docker
fi

if ! command -v crontab >/dev/null 2>&1; then
  apt-get update
  apt-get install -y cron
  systemctl enable --now cron
fi

# jq: only used to pull the two fields we need (access_token, then
# payload.data) out of the metadata-server/Secret Manager JSON responses
# below, without pulling in a heavier dependency.
if ! command -v jq >/dev/null 2>&1; then
  apt-get update
  apt-get install -y jq
fi

# Fetches one Secret Manager secret's latest version, authenticated as this
# VM's own service account via the metadata server — never a value Terraform
# rendered into this script's text (which instance metadata is: readable by
# anyone with compute viewer access, and by any process on the VM). Requires
# the caller to already hold roles/secretmanager.secretAccessor on the
# secret (see main.tf's google_secret_manager_secret_iam_member grants).
fetch_secret() {
  secret_id="$1"
  token="$(curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" | jq -r .access_token)"
  curl -sf -H "Authorization: Bearer $token" \
    "https://secretmanager.googleapis.com/v1/projects/${gcp_project_id}/secrets/$secret_id/versions/latest:access" \
    | jq -r .payload.data | base64 -d
}

ROOT_PASSWORD="$(fetch_secret "${root_password_secret_id}")"
APP_DB_PASSWORD="$(fetch_secret "${app_db_password_secret_id}")"

# Ops Agent: ships this VM's CPU/memory/disk metrics (monitoring module's
# mongo-vm dashboard/alerts) and forwards journald/syslog — including the
# backup cron's OK/FAIL markers below — to Cloud Logging. Requires the
# service_account block above (main.tf); without it, the agent runs but
# every write 403s silently. Idempotent: skipped once already installed, so
# a re-run of this script on a later boot doesn't reinstall it.
if ! dpkg -s google-cloud-ops-agent >/dev/null 2>&1; then
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
fi

# Runs once, only against an empty data directory: the mongo image's
# entrypoint skips everything in docker-entrypoint-initdb.d/ (and skips
# creating MONGO_INITDB_ROOT_USERNAME/PASSWORD) on every boot after the
# data directory already has a database in it.
#
# db.getSiblingDB(app_database_name).createUser(...) makes app_database_name
# this user's *authentication* database (separate from the readWrite role
# below, which is what actually scopes its permissions) — every consumer of
# this user (main.tf's connection string, the backup script below) must use
# authSource=app_database_name to match, not "admin".
cat > "$INITDB_DIR/init-app-user.js" <<EOF
db.getSiblingDB("${app_database_name}").createUser({
  user: "${app_db_username}",
  pwd: "$APP_DB_PASSWORD",
  roles: [{ role: "readWrite", db: "${app_database_name}" }]
});
EOF

MONGOD_ARGS="--bind_ip_all"
if [ "${wiredtiger_cache_gb}" != "0" ]; then
  MONGOD_ARGS="$MONGOD_ARGS --wiredTigerCacheSizeGB ${wiredtiger_cache_gb}"
fi

docker rm -f mongo 2>/dev/null || true
# shellcheck disable=SC2086
docker run -d \
  --name mongo \
  --restart=always \
  -p ${mongo_port}:27017 \
  -v "$DB_DIR:/data/db" \
  -v "$BACKUP_DIR:/backup" \
  -v "$INITDB_DIR:/docker-entrypoint-initdb.d" \
  -e MONGO_INITDB_ROOT_USERNAME=${root_username} \
  -e MONGO_INITDB_ROOT_PASSWORD="$ROOT_PASSWORD" \
  "${mongo_image}" $MONGOD_ARGS

# --- Daily mongodump, via cron, straight to the same disk the snapshot
#     policy below targets — see mongo-vm/main.tf for the snapshot side of
#     this and why the two are staggered by more than mongodump's runtime. ---

cat > /opt/mongo-backup.sh <<'BACKUP_EOF'
#!/bin/bash
set -euo pipefail

TS="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="/mnt/mongo-data/backups"

# MONGO_BACKUP_OK / MONGO_BACKUP_FAIL markers, shipped to Cloud Logging by
# the Ops Agent (see the install block above) via journald/syslog — the
# monitoring module alerts on FAIL appearing, and separately on neither
# marker appearing at all in a day (the cron itself not running, or every
# command before this line failing). Written as a literal marker in the
# message text, not just the `logger -t` tag, so the Cloud Logging filter
# doesn't depend on which field the Ops Agent's syslog receiver puts the tag
# in. `set -e` means the ERR trap fires (and the shell then exits) on any
# failing command below, including mongodump itself.
trap 'logger -t llm-engine-mongo-backup "MONGO_BACKUP_FAIL ts=$TS"' ERR

# Fetched fresh on every run rather than persisted anywhere on disk — same
# fetch_secret approach as the boot script above (metadata-server token,
# then the Secret Manager REST API), just duplicated here since this file
# runs standalone under cron, in a process with none of that script's
# shell state.
token="$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" | jq -r .access_token)"
APP_DB_PASSWORD="$(curl -sf -H "Authorization: Bearer $token" \
  "https://secretmanager.googleapis.com/v1/projects/${gcp_project_id}/secrets/${app_db_password_secret_id}/versions/latest:access" \
  | jq -r .payload.data | base64 -d)"

docker exec mongo mongodump \
  --host 127.0.0.1 --port 27017 \
  --username '${app_db_username}' --password "$APP_DB_PASSWORD" \
  --authenticationDatabase '${app_database_name}' \
  --db '${app_database_name}' \
  --archive="/backup/mongodump-$TS.gz" --gzip

# Retention: prune local archives older than backup_retention_days. This is
# the *local* copy only — the scheduled disk snapshot (main.tf) is what
# gives these dumps their own independent retention window on GCP's side.
find "$BACKUP_DIR" -maxdepth 1 -name 'mongodump-*.gz' -mtime +${backup_retention_days} -delete

logger -t llm-engine-mongo-backup "MONGO_BACKUP_OK ts=$TS"
BACKUP_EOF
# 700, not the more common 755: this script's text itself is no longer
# secret (see above), but keep it non-readable by other local users as
# defense in depth anyway — belt-and-suspenders alongside fetching the
# password fresh each run instead of embedding it.
chmod 700 /opt/mongo-backup.sh

cat > /etc/cron.d/mongo-backup <<EOF
0 ${backup_hour_utc} * * * root /opt/mongo-backup.sh >> /var/log/mongo-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/mongo-backup
