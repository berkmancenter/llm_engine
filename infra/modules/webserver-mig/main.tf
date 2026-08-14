# Web server instance template + regional MIG + autoscaler + HTTPS load
# balancer (module B4). No Caddy anywhere — TLS termination and path-based
# routing both happen at the load balancer.

# --- Service account the VMs run as ---

resource "google_service_account" "web_server" {
  project      = var.project_id
  account_id   = "llm-engine-web-server"
  display_name = "llm_engine web server (MIG)"
}

resource "google_project_iam_member" "web_server_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.web_server.email}"
}

resource "google_project_iam_member" "web_server_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.web_server.email}"
}

resource "google_project_iam_member" "web_server_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.web_server.email}"
}

# Secret must already exist (see manual-setup-checklist.md item 7) — this
# grants access by name without Terraform owning the secret's value.
resource "google_secret_manager_secret_iam_member" "web_server_app_env_access" {
  project   = var.project_id
  secret_id = var.app_env_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_server.email}"
}

# This secret IS Terraform-owned — created by the atlas-cluster module.
resource "google_secret_manager_secret_iam_member" "web_server_mongodb_url_access" {
  project   = var.project_id
  secret_id = var.mongodb_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_server.email}"
}

# --- Instance template ---

resource "google_compute_instance_template" "web_server" {
  project      = var.project_id
  name_prefix  = "llm-engine-web-"
  region       = var.region
  machine_type = var.machine_type
  tags         = [var.network_tag, var.iap_ssh_tag]
  labels       = merge(var.labels, { component = "web-server" })

  disk {
    source_image = var.boot_disk_image
    auto_delete  = true
    boot         = true
    disk_size_gb = var.boot_disk_size_gb
    disk_type    = "pd-balanced"
  }

  network_interface {
    subnetwork = var.subnet_self_link
    # No access_config: no external IP. All inbound traffic arrives via the
    # load balancer (module network's firewall rule allows the LB's ranges).
  }

  service_account {
    email  = google_service_account.web_server.email
    scopes = ["cloud-platform"] # fine-grained access controlled by IAM roles above, not OAuth scopes
  }

  metadata = {
    startup-script = templatefile("${path.module}/startup-script.sh.tpl", {
      image                 = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_registry_repo}/llm-engine:${var.web_server_image_tag}"
      region                = var.region
      api_port              = var.api_port
      ws_port               = var.ws_port
      mongodb_url_secret_id = var.mongodb_url_secret_id
      app_env_secret_id     = var.app_env_secret_id
      chroma_url            = var.chroma_url
    })
  }

  lifecycle {
    create_before_destroy = true # name_prefix + this lets the MIG roll to a new template without downtime
  }
}

# --- Health check (shared: both named ports are served by the same process) ---

resource "google_compute_health_check" "web_server" {
  project             = var.project_id
  name                = "llm-engine-web-server-health"
  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3

  http_health_check {
    port         = var.api_port
    request_path = "/v1/health"
  }
}

# --- Regional Managed Instance Group ---

resource "google_compute_region_instance_group_manager" "web_server" {
  project                   = var.project_id
  name                      = "llm-engine-web-mig"
  region                    = var.region
  distribution_policy_zones = [var.zone] # see var.zone for why this is pinned to one zone
  base_instance_name        = "llm-engine-web"
  target_size               = var.min_replicas # autoscaler takes ownership of this after creation

  version {
    instance_template = google_compute_instance_template.web_server.id
  }

  named_port {
    name = "api-port"
    port = var.api_port
  }

  named_port {
    name = "ws-port"
    port = var.ws_port
  }

  auto_healing_policies {
    health_check      = google_compute_health_check.web_server.id
    initial_delay_sec = 120
  }

  update_policy {
    type                  = "PROACTIVE"
    minimal_action        = "REPLACE"
    max_surge_fixed       = var.max_surge
    max_unavailable_fixed = var.max_unavailable
  }
}
