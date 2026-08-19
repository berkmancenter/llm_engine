#!/bin/bash
set -euo pipefail

# Runs the llm_engine container. The image itself has no baked-in secrets —
# runtime config comes from two Secret Manager secrets merged into one env
# file before `docker run`:
#   - "${app_env_secret_id}": dotenv blob (JWT secret, LLM provider API
#     keys, SMTP creds, etc — see .env.example for the full set). App
#     config, not something Terraform should own or that should live in
#     this repo — create/update it yourself:
#       gcloud secrets create ${app_env_secret_id} --data-file=prod.env
#       gcloud secrets versions add ${app_env_secret_id} --data-file=prod.env
#   - "${mongodb_url_secret_id}": Atlas connection string, Terraform-owned
#     (written by the atlas-cluster module) — never templated into instance
#     metadata in plaintext.
# Chroma's URL is non-secret (internal IP, no credentials) and passed
# directly as a Terraform-templated value instead.

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker.io
  systemctl enable --now docker
fi

# debian-cloud/debian-12's base image does not ship the gcloud CLI —
# install it (needed below for Artifact Registry auth + Secret Manager).
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

gcloud auth configure-docker ${region}-docker.pkg.dev --quiet

ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
gcloud secrets versions access latest --secret=${app_env_secret_id} > "$ENV_FILE"
{
  echo "MONGODB_URL=$(gcloud secrets versions access latest --secret=${mongodb_url_secret_id})"
  echo "PORT=${api_port}"
  echo "WEBSOCKET_BASE_PORT=${ws_port}"
  echo "CHROMA_DB_URL=${chroma_url}"
} >> "$ENV_FILE"

docker rm -f llm-engine 2>/dev/null || true
# Skipped when the exact tagged image is already present - a per-release
# baked image (packer/web-server-release.pkr.hcl) pre-pulls it, so most
# boots hit this branch and skip the pull entirely. Falls back to a normal
# pull whenever it isn't there (boot_disk_image not baked, a bake that
# failed and fell back to the plain base image, a rollback where only
# web_server_image_tag was flipped) - always correct, just not always fast.
if ! docker image inspect "${image}" >/dev/null 2>&1; then
  docker pull "${image}"
fi
# --log-driver=gcplogs ships the container's stdout/stderr to Cloud Logging.
# Without it the app's own logs exist only inside the container, reachable
# only by SSHing to a live instance - which is correctly permission-gated and
# impossible once an instance has been replaced by the autoscaler. That gap
# blocked three separate investigations in Aug 2026: attributing boot-to-healthy
# time between Mongo connect and agent initialisation, explaining a burst of
# websocket disconnects, and confirming what the app did during a scale-out.
# In an autoscaled group the instance holding the evidence is usually gone by
# the time anyone looks, so "just SSH in" is not a recovery plan.
#
# The instance service account already holds roles/logging.logWriter (granted
# for the connection metric), so this needs no additional IAM.
docker run -d \
  --name llm-engine \
  --restart=always \
  --log-driver=gcplogs \
  --log-opt labels=container_name \
  -p ${api_port}:${api_port} \
  -p ${ws_port}:${ws_port} \
  --env-file "$ENV_FILE" \
  "${image}"
