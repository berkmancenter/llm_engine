# Single always-on VM for bot-media-server: a meeting bot's camera+mic
# presence (see bot-media-server/README.md). Not a MIG/autoscaler, same
# reasoning as archive-wiki-vm/chroma-vm: one process, no cluster to scale
# — and unlike webserver-mig, replacing this instance mid-call drops a live
# meeting bot's feed, so updates are a deliberate, manually-timed
# `apply -replace`, never an automated rolling update.
#
# Runs bot-media-server directly under systemd (no Docker): same rationale
# as archive-wiki-vm (see that module's own main.tf comment) — no published
# image exists for this process either, so replicating its own already-
# documented native run (yarn install; yarn bot-media-server, no build
# step — it runs via the ts-node/esm loader) is less to build and maintain
# than inventing a Dockerfile and a second image pipeline. Unlike
# archive-wiki-vm, llm_engine is a public repo, so no deploy key is needed.
#
# Runtime secrets follow webserver-mig's app_env_secret_id pattern (fetched
# at boot via gcloud, never baked into instance metadata) rather than
# archive-wiki-vm's bake-at-apply-time pattern, since that's the convention
# already established for this same monorepo's other native process.

resource "google_service_account" "bot_media_server_vm" {
  project      = var.project_id
  account_id   = "llm-engine-bot-media-server-vm"
  display_name = "llm_engine bot-media-server-vm"
}

resource "google_project_iam_member" "bot_media_server_vm_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.bot_media_server_vm.email}"
}

resource "google_project_iam_member" "bot_media_server_vm_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.bot_media_server_vm.email}"
}

# Secret must already exist (see manual-setup-checklist.md) — this grants
# access by name without Terraform owning the secret's value, same as
# webserver-mig's web_server_app_env_access.
resource "google_secret_manager_secret_iam_member" "bot_media_server_app_env_access" {
  project   = var.project_id
  secret_id = var.app_env_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.bot_media_server_vm.email}"
}

# Bucket must already exist (see manual-setup-checklist.md) — read-only
# access to sync the staged Kokoro model files at boot.
resource "google_storage_bucket_iam_member" "bot_media_server_model_bucket_access" {
  bucket = var.model_bucket_name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.bot_media_server_vm.email}"
}

resource "google_compute_instance" "bot_media_server" {
  project      = var.project_id
  name         = "llm-engine-bot-media-server-vm"
  zone         = var.zone
  machine_type = var.machine_type
  tags         = [var.network_tag, var.iap_ssh_tag]
  labels       = merge(var.labels, { component = "bot-media-server-vm" })

  boot_disk {
    initialize_params {
      image = var.boot_disk_image
      size  = var.boot_disk_size_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = var.subnet_self_link
    # No access_config block: intentionally no external IP. Reachable only
    # via the LB (through the NEG/backend service below) and, for admin
    # access, IAP SSH tunneling — same as every other VM in this project.
  }

  service_account {
    email  = google_service_account.bot_media_server_vm.email
    scopes = ["cloud-platform"] # fine-grained access controlled by IAM roles above, not OAuth scopes
  }

  metadata = {
    startup-script = templatefile("${path.module}/startup-script.sh.tpl", {
      checkout_ref          = var.web_server_image_tag
      bot_media_server_port = var.bot_media_server_port
      app_env_secret_id     = var.app_env_secret_id
      model_bucket_name     = var.model_bucket_name
      llm_engine_url        = var.llm_engine_url
      llm_engine_ws_url     = var.llm_engine_ws_url
    })
  }

  # Stateful singleton with an in-place boot disk (git checkout + node_modules
  # + synced models) — stop/start in place on a change that would otherwise
  # force recreation, same as archive-wiki-vm/chroma-vm/mongo-vm. A
  # startup-script metadata change (e.g. a new web_server_image_tag) does
  # NOT re-run on its own — the script is gated on the checkout not already
  # existing, deliberately, same as archive-wiki-vm's own code (not
  # content) updates: pick a moment with no active calls, then
  # `terraform apply -replace=module.bot_media_server_vm.google_compute_instance.bot_media_server`
  # for a clean re-clone at the new ref, per this repo's own rule
  # (-replace, never destroy -target).
  allow_stopping_for_update = true
}

# --- LB backend: a zonal NEG pointed straight at this one VM+port, since
#     it's a standalone instance, not a MIG. See webserver-mig's
#     extra_host_backends variable for how this plugs into the shared LB. ---

resource "google_compute_network_endpoint_group" "bot_media_server" {
  project               = var.project_id
  name                  = "llm-engine-bot-media-server-neg"
  network_endpoint_type = "GCE_VM_IP_PORT"
  zone                  = var.zone
  network               = var.network_self_link
  subnetwork            = var.subnet_self_link
  default_port          = var.bot_media_server_port
}

resource "google_compute_network_endpoint" "bot_media_server" {
  network_endpoint_group = google_compute_network_endpoint_group.bot_media_server.id
  # Not inferred from network_endpoint_group above despite the two sharing
  # the same NEG id — the provider errors "zone: required field is not
  # set" at plan time without this explicit field (same fix archive-wiki-vm
  # needed the first time it was wired in).
  zone       = var.zone
  instance   = google_compute_instance.bot_media_server.name
  ip_address = google_compute_instance.bot_media_server.network_interface[0].network_ip
  port       = var.bot_media_server_port
}

resource "google_compute_health_check" "bot_media_server" {
  project = var.project_id
  name    = "llm-engine-bot-media-server-health-check"

  http_health_check {
    port         = var.bot_media_server_port
    request_path = var.health_check_path
  }
}

resource "google_compute_backend_service" "bot_media_server" {
  project               = var.project_id
  name                  = "llm-engine-bot-media-server-backend"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  # This is a hard connection-lifetime cap, not an idle timeout — GCP closes
  # the socket.io connection once it's been open this long, active or not.
  # 86400 (24h) rather than webserver-mig's 3600: that value already forces
  # a reconnect once an hour, and here that means bot-media-server's own
  # ~60s pre-disconnect grace period (app.ts) has to be enough to bridge
  # every such reconnect for a live meeting — worth raising the ceiling
  # rather than relying on that grace period once an hour, every hour.
  # Tradeoff: a wedged/unresponsive backend instance also won't get
  # dropped by the LB until this same ceiling elapses.
  timeout_sec   = 86400
  health_checks = [google_compute_health_check.bot_media_server.id]

  backend {
    group                 = google_compute_network_endpoint_group.bot_media_server.id
    balancing_mode        = "RATE"
    max_rate_per_endpoint = 50 # one small VM behind this — a low ceiling is the point, not a limit anyone should expect to hit
  }
}
