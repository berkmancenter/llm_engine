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
  description = <<-EOT
    Instance shape. Drives WEBSOCKET_MAX_PARALLELISM (main.tf's
    websocket_max_parallelism local, cores - 1) as well as vCPU/RAM, so
    there is no separate "core count" variable to keep in sync — bumping
    this alone is enough. Expects a standard N-family shape ending in
    "-<vCPU count>" (n2d-standard-N, n2d-highmem-N, ...); a shared-core
    shape (e2-micro/small/medium) won't parse and isn't used by this module
    today.
  EOT
  type        = string
  default     = "n2d-standard-2"
}

variable "boot_disk_image" {
  description = <<-EOT
    Base OS image. startup-script.sh.tpl installs Docker onto it at boot,
    but only if it isn't already there (`if ! command -v docker` - see the
    script) - so this is safe to point at either a plain OS image or a
    pre-baked one. Defaults to plain debian-cloud/debian-12, which installs
    Docker fresh on every instance boot: ~35s of the ~136s boot-to-healthy
    time measured during the autoscaling load test (see k6/README.md and
    the published diagnostic report). For faster scale-out, build
    packer/web-server-base.pkr.hcl and point this at the image family it
    produces instead:
      "projects/<project_id>/global/images/family/llm-engine-web-base"
    No other change needed - the startup script's own idempotency check is
    what makes this a drop-in swap.
  EOT
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
  description = <<-EOT
    MIG maximum size. Raised from the original placeholder of 2 to 8 —
    scale-down to min_replicas when idle keeps the cost of a higher ceiling
    negligible, so there's no reason to artificially cap burst capacity this
    low before real usage data (e.g. the k6 load tests, see k6/README.md)
    says otherwise.
  EOT
  type        = number
  default     = 8
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

variable "log_level" {
  description = <<-EOT
    Minimum severity the app logs. Passed to the container explicitly so the
    volume shipped to Cloud Logging is bounded by config rather than by
    whatever LOG_LEVEL happens to be in the app-env secret.

    "info" is the app's own production default, so this normally changes
    nothing — it makes the guarantee explicit and reviewable. Note the
    container's stdout reaches Cloud Logging as severity INFO regardless of
    the app's internal level (winston formats the level into the message
    text, and only `error` goes to stderr), so debug lines cannot be filtered
    or excluded after the fact. Keeping them out at the source is the only
    control over ingestion volume.

    Raise to "debug" deliberately and temporarily when diagnosing something,
    and put it back — debug is many times the volume of info.
  EOT
  type        = string
  default     = "info"
  validation {
    condition     = contains(["debug", "info", "warn", "error"], var.log_level)
    error_message = "log_level must be one of: debug, info, warn, error."
  }
}
