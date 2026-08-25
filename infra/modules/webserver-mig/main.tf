# Web server instance template + regional MIG + autoscaler + HTTPS load
# balancer (module B4). No Caddy anywhere — TLS termination and path-based
# routing both happen at the load balancer.

# The process model is one primary (Express API + websocket sticky master,
# sharing an event loop) plus one cluster worker per core — cores + 1
# threads on cores cores, oversubscribed unless a worker is held back. See
# docs/autoscaling-completion-checklist.md §3 point 4. Parsed from
# machine_type rather than a second variable so the two can't drift — see
# that variable's description for the shape this expects.
locals {
  vcpu_count                = tonumber(regex("-([0-9]+)$", var.machine_type)[0])
  websocket_max_parallelism = max(local.vcpu_count - 1, 1)
}

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

# --- Service account the Packer release build runs as ---
#
# Deliberately NOT web_server above: that account also holds
# secretmanager.secretAccessor on both prod secrets (app env + Mongo URL,
# see the two bindings below main.tf's instance template). The release
# build's build VM runs third-party code (apt/gcloud install, the docker
# pull itself) under whatever identity is attached to it, so it should
# only be able to do what the build actually needs - read the app image -
# not read production secrets too. See web-server-release.pkr.hcl's
# service_account_email.
resource "google_service_account" "web_image_builder" {
  project      = var.project_id
  account_id   = "llm-engine-web-image-builder"
  display_name = "llm_engine web-server image builder (Packer)"
}

resource "google_project_iam_member" "web_image_builder_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.web_image_builder.email}"
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
      image                     = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_registry_repo}/llm-engine:${var.web_server_image_tag}"
      region                    = var.region
      api_port                  = var.api_port
      ws_port                   = var.ws_port
      mongodb_url_secret_id     = var.mongodb_url_secret_id
      app_env_secret_id         = var.app_env_secret_id
      chroma_url                = var.chroma_url
      log_level                 = var.log_level
      websocket_max_parallelism = local.websocket_max_parallelism
    })
  }

  lifecycle {
    create_before_destroy = true # name_prefix + this lets the MIG roll to a new template without downtime
  }
}

# --- Health checks ---
#
# Two separate checks, not one shared between the api and websocket backend
# services below: api-port and ws-port are the same process, but a hung or
# crashed websocket listener with the API still answering would otherwise
# never be detected - the api backend's checks would keep passing and the
# ws backend would keep getting routed traffic with no alarm. Each backend
# service (lb.tf) references only the check for its own port.

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

resource "google_compute_health_check" "web_server_ws" {
  project             = var.project_id
  name                = "llm-engine-web-server-ws-health"
  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3

  # TCP, not an HTTP GET on the socket.io path: Engine.IO 400s a bare GET
  # without its own transport/EIO query params (verified against this
  # app's actual socket.io server - a plain GET is not, in fact, a 200),
  # and matching that protocol here would coincidentally couple this check
  # to whatever Engine.IO protocol version socket.io happens to speak. A
  # TCP connect only confirms something is listening on ws_port, not that
  # the app answers on it - lighter than a full protocol handshake, but
  # already the failure mode this check exists for (the listener died).
  tcp_health_check {
    port = var.ws_port
  }
}

# --- Regional Managed Instance Group ---

resource "google_compute_region_instance_group_manager" "web_server" {
  project                   = var.project_id
  name                      = "llm-engine-web-mig"
  region                    = var.region
  distribution_policy_zones = [var.zone] # see var.zone for why this is pinned to one zone
  base_instance_name        = "llm-engine-web"

  # Seeds the group's initial size only. From then on the autoscaler owns
  # it, so ignore_changes below stops Terraform taking it back — see the
  # lifecycle block at the bottom of this resource.
  target_size = var.min_replicas

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

  # target_size is set by the autoscaler at runtime, not by this config, so
  # Terraform must stop treating a scaled-up group as drift to correct.
  #
  # Without this, target_size reads as a diff (`1 -> 2`, or `1 -> 8` at the
  # current max) on any plan taken while the autoscaler is above
  # min_replicas — and applying that diff scales the group back down to the
  # minimum. That is worst exactly when it is least affordable: the group is
  # only ever scaled up because load put it there, and the deploy pipeline's
  # apply is unscoped, so a routine release during a traffic spike would
  # cut capacity to min_replicas mid-spike. The autoscaler would climb back,
  # but only after new instances boot and pass health checks.
  #
  # ignore_changes applies to updates only, so var.min_replicas still seeds
  # the group at creation. Changing min_replicas later is still honored —
  # it flows through the autoscaler's own minNumReplicas (autoscaler.tf),
  # which is the thing that actually enforces a floor at runtime.
  lifecycle {
    ignore_changes = [target_size]
  }
}
