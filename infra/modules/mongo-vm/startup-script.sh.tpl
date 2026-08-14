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
mount -o discard,defaults "$DATA_DEVICE" "$MOUNT_POINT"
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

# Runs once, only against an empty data directory: the mongo image's
# entrypoint skips everything in docker-entrypoint-initdb.d/ (and skips
# creating MONGO_INITDB_ROOT_USERNAME/PASSWORD) on every boot after the
# data directory already has a database in it.
cat > "$INITDB_DIR/init-app-user.js" <<EOF
db.getSiblingDB("${app_database_name}").createUser({
  user: "${app_db_username}",
  pwd: "${app_db_password}",
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
  -e MONGO_INITDB_ROOT_PASSWORD='${root_password}' \
  "${mongo_image}" $MONGOD_ARGS

# --- Daily mongodump, via cron, straight to the same disk the snapshot
#     policy below targets — see mongo-vm/main.tf for the snapshot side of
#     this and why the two are staggered by more than mongodump's runtime. ---

cat > /opt/mongo-backup.sh <<'BACKUP_EOF'
#!/bin/bash
set -euo pipefail

TS="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="/mnt/mongo-data/backups"

docker exec mongo mongodump \
  --host 127.0.0.1 --port 27017 \
  --username '${app_db_username}' --password '${app_db_password}' \
  --authenticationDatabase admin \
  --db '${app_database_name}' \
  --archive="/backup/mongodump-$TS.gz" --gzip

# Retention: prune local archives older than backup_retention_days. This is
# the *local* copy only — the scheduled disk snapshot (main.tf) is what
# gives these dumps their own independent retention window on GCP's side.
find "$BACKUP_DIR" -maxdepth 1 -name 'mongodump-*.gz' -mtime +${backup_retention_days} -delete
BACKUP_EOF
chmod +x /opt/mongo-backup.sh

cat > /etc/cron.d/mongo-backup <<EOF
0 ${backup_hour_utc} * * * root /opt/mongo-backup.sh >> /var/log/mongo-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/mongo-backup
