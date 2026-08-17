variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  description = <<-EOT
    Single zone the regional MIG's instances are pinned to
    (distribution_policy_zones). Not really an HA choice at this scale (see
    max_replicas) — it's here because GCP requires a *fixed* max_surge/
    max_unavailable on a regional MIG to be either 0 or >= the number of
    zones the group spans; defaulting to every zone in the region (the
    behavior with no distribution_policy_zones at all) means max_surge=1
    fails outright. Revisit alongside max_replicas once real multi-zone HA
    is actually a goal.
  EOT
  type        = string
  default     = "us-central1-a"
}

variable "subnet_self_link" {
  type = string
}

variable "network_tag" {
  type    = string
  default = "web-server"
}

variable "iap_ssh_tag" {
  type    = string
  default = "iap-ssh"
}

variable "machine_type" {
  type    = string
  default = "n2d-standard-2"
}

variable "boot_disk_image" {
  description = "Base OS image the startup script installs Docker onto."
  type        = string
  default     = "debian-cloud/debian-12"
}

variable "boot_disk_size_gb" {
  description = <<-EOT
    The app runs from a pulled container image, not baked into this disk —
    just needs room for the OS + Docker + gcloud CLI + the pulled image.
    20GB is comfortable headroom for that in practice.
  EOT
  type        = number
  default     = 20
}

variable "artifact_registry_repo" {
  description = "Artifact Registry repo name (see manual-setup-checklist.md item 6)."
  type        = string
  default     = "llm-engine"
}

variable "web_server_image_tag" {
  description = <<-EOT
    Container image tag to deploy. Bumped by the Part D CI/CD pipeline on
    every release via `terraform apply -var web_server_image_tag=<sha>` —
    see docs/infrastructure/cicd.md.
  EOT
  type        = string
  default     = "latest"
}

variable "api_port" {
  description = "api-port named port — the app's HTTP API (config.port / PORT)."
  type        = number
  default     = 3000
}

variable "ws_port" {
  description = "ws-port named port — the app's websocket service (WEBSOCKET_BASE_PORT)."
  type        = number
  default     = 5555
}

variable "mongodb_url_secret_id" {
  description = <<-EOT
    Secret Manager secret name holding the Atlas connection string (from the
    atlas-cluster module's mongodb_url_secret_id output). Fetched at boot,
    same pattern as app_env_secret_id — never templated into instance
    metadata in plaintext.
  EOT
  type        = string
}

variable "chroma_url" {
  description = "Internal Chroma URL (from the chroma-vm module)."
  type        = string
}

variable "app_env_secret_id" {
  description = "Secret Manager secret name holding the app's dotenv-formatted runtime config (see manual-setup-checklist.md item 7)."
  type        = string
  default     = "llm-engine-app-env"
}

variable "min_replicas" {
  description = "MIG minimum size — the always-on baseline capacity."
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "MIG maximum size to start. Revisit once real usage data exists (see plan's open items)."
  type        = number
  default     = 2
}

variable "concurrent_connections_target" {
  description = <<-EOT
    Target concurrent-connection value per instance for the custom-metric
    autoscaling signal. Placeholder — open item from the plan: confirm
    actual concurrent websocket connection counts from current production
    traffic before trusting this default.
  EOT
  type        = number
  default     = 250
}

variable "cpu_utilization_target" {
  description = "Fallback autoscaling signal if the custom connections metric isn't reporting."
  type        = number
  default     = 0.6
}

variable "max_surge" {
  type    = number
  default = 1
}

variable "max_unavailable" {
  type    = number
  default = 0
}

variable "connection_draining_timeout_sec" {
  description = "Grace period for in-flight websocket connections before an instance is removed from serving."
  type        = number
  default     = 120
}

variable "domain" {
  description = "Public hostname the load balancer serves (managed SSL cert + URL map host rule)."
  type        = string
  # No default, deliberately: this is per-deployment, not something a
  # shared reference module should assume.
}

variable "additional_domains" {
  description = <<-EOT
    Extra hostnames to add to the managed SSL cert and URL map host rule
    alongside var.domain — e.g. a test/staging domain pointed at the same
    LB IP. Google's managed cert supports up to 100 domains on one
    certificate, so this doesn't need its own cert/proxy/forwarding rule;
    all listed hosts route through the same "main" path_matcher (so
    /socket.io/* routing works identically for every domain here).
  EOT
  type        = list(string)
  default     = []
}

variable "frontend_origin" {
  description = <<-EOT
    Hostname (no scheme, no path — e.g. "my-app.vercel.app") of an
    external frontend origin to proxy at this LB's fallback route (any
    path not matched by /v1/* or /socket.io/*, see lb.tf), so the frontend
    and this backend can be served from the same domain. Built for a
    Vercel deployment specifically: the LB's Host header is rewritten to
    this value on the way out, since Vercel (like most host-based routers)
    picks which deployment to serve by Host header and would otherwise see
    var.domain instead and not know what to serve.

    Leave "" (the default) to skip this entirely — no frontend backend/NEG
    gets created, and the fallback route just goes to the api backend
    (its own 404 handler), same as before this existed.
  EOT
  type        = string
  default     = ""
}

variable "labels" {
  type    = map(string)
  default = {}
}
