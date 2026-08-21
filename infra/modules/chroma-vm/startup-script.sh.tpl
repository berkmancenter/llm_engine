#!/bin/bash
set -euo pipefail

# Format (only on first boot) and mount the attached persistent SSD for
# Chroma's data directory, then run Chroma as a Docker container. This VM has
# no external IP at all, so binding to all interfaces only exposes Chroma on
# the internal VPC network; the network module's firewall rule further
# restricts inbound access to web-server-tagged instances only.

DATA_DEVICE="/dev/disk/by-id/google-chroma-data"
MOUNT_POINT="/mnt/chroma-data"

mkdir -p "$MOUNT_POINT"
if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then
  mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard "$DATA_DEVICE"
fi
mount -o discard,defaults "$DATA_DEVICE" "$MOUNT_POINT"
chmod 777 "$MOUNT_POINT" # container runs as a non-root user internally

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker.io
  systemctl enable --now docker
fi

# Ops Agent: ships this VM's CPU/memory/disk metrics to Cloud Monitoring —
# what the monitoring module's chroma_memory_pressure alert and disk-space
# alert both actually need to fire. Requires the service_account block
# above (main.tf); without it, the agent runs but every write 403s
# silently. Idempotent: skipped once already installed.
if ! dpkg -s google-cloud-ops-agent >/dev/null 2>&1; then
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
fi

docker rm -f chroma 2>/dev/null || true
docker run -d \
  --name chroma \
  --restart=always \
  -p ${chroma_port}:${chroma_port} \
  -v "$MOUNT_POINT:/data" \
  -e IS_PERSISTENT=TRUE \
  -e PERSIST_DIRECTORY=/data \
  "${chroma_image}"
