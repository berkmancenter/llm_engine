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

    Default raised from n2d-standard-2 to n2d-standard-4: at 2 cores,
    WEBSOCKET_MAX_PARALLELISM = cores - 1 leaves exactly one websocket
    worker, no real parallelism. See
    docs/autoscaling-completion-checklist.md §3 point 4.
  EOT
  type        = string
  default     = "n2d-standard-4"
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

variable "extra_host_backends" {
  description = <<-EOT
    Extra hostname(s) to front through this same LB/static IP/managed cert,
    each routed entirely to its own backend service — for an unrelated
    small service sharing this LB rather than another domain for this app
    (that's additional_domains, above). Each host gets its own host_rule
    and a path_matcher with no path_rules of its own (default_service only),
    so the whole domain goes to that one backend regardless of path — unlike
    additional_domains, which shares this app's /v1/* and /socket.io/*
    splits. Built for archive-wiki-vm (see manual-setup-checklist.md item 5):
    pass its backend_service output here rather than giving it a second LB
    IP and a second managed cert. Every domain across every entry (plus
    var.domain and var.additional_domains) lands on the one shared cert —
    still within Google's 100-domain-per-cert limit at this scale.
  EOT
  type = list(object({
    domains            = list(string)
    backend_service_id = string
  }))
  default = []
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

variable "legacy_origin" {
  description = <<-EOT
    External IP address of a legacy box to front through this same LB,
    static IP, and managed cert — built for asml-nextspace's old
    single-box deployment during its data-tier migration (see
    llm_engine-infra's docs/autoscaling-completion-checklist.md, Phase 0).

    Protocol is HTTPS: the legacy box terminates its own TLS (Caddy) and
    keeps doing so — this LB's managed cert covers the client-facing leg
    only; the LB re-encrypts to whatever cert the legacy box itself
    presents.

    Leave "" (the default) to skip this entirely — no legacy backend/NEG
    gets created.
  EOT
  type        = string
  default     = ""
}

variable "legacy_domains" {
  description = <<-EOT
    Domain(s) var.legacy_active's toggle applies to — deliberately kept
    entirely separate from var.domain/var.additional_domains ("main"
    path_matcher) so flipping legacy_active can never affect those (an
    earlier version of this mechanism didn't separate them, and flipping
    legacy_active would have rerouted whatever was already live on "main"
    — e.g. a preview domain — right along with the intended legacy
    domain; see git history if curious). All entries share one host_rule
    + path_matcher (and so one shared legacy_active toggle) rather than
    getting one each — built for a set of domains that should all cut
    over together, not independently; use extra_host_backends instead for
    a domain that should always go to its own fixed backend regardless of
    legacy_active. Routed entirely to the legacy backend when
    var.legacy_active is true, or to this app's own normal
    api/websocket/frontend split (the same split "main" uses) when false
    — so these domains can eventually rejoin normal routing without ever
    having been entangled with var.domain's own traffic.

    No Host header rewrite is applied on the way to var.legacy_origin —
    see the legacy backend service's own comment in lb.tf for why: with
    more than one domain possibly sharing this backend, there's no single
    fixed value that would be correct for all of them, so the original
    client Host header passes through unmodified instead, which is what
    each domain's own vhost on the legacy box needs to see anyway.

    Every entry is included on the managed cert (see
    local.ssl_cert_domains), same as var.domain/additional_domains — so
    each domain's DNS needs to actually resolve here before real traffic
    for it can reach this LB at all, same caution as var.domain. Leave []
    (the default) to skip entirely — no separate host_rule/path_matcher
    gets created, and legacy_active has nothing to apply to.
  EOT
  type        = list(string)
  default     = []
}

variable "legacy_active" {
  description = <<-EOT
    When true (and both var.legacy_origin is set and var.legacy_domains is
    non-empty), routes every domain in var.legacy_domains — their shared
    host_rule's default_service and path rules, entirely separate from
    "main" — to the legacy backend instead of this app's own
    api/websocket/frontend split. Scoped to exactly var.legacy_domains;
    never touches var.domain/var.additional_domains ("main"), regardless
    of what's on either list.

    Defaults false: var.legacy_domains (if set) gets this app's own normal
    split-routing behavior, same as "main" would. The backend/NEG still
    gets created whenever legacy_origin is set even with this false, so
    it's immediately switchable — it's just not in the routing path yet.
  EOT
  type        = bool
  default     = false
}

variable "legacy_fallback_domain" {
  description = <<-EOT
    The one domain var.legacy_fallback_active's toggle applies to — built
    for nextspace.asml.berkmancenter.org specifically (see
    llm_engine-infra's docs/autoscaling-completion-checklist.md, Phase 0),
    kept as its own single-domain mechanism rather than folded into
    var.legacy_domains/var.legacy_active above: that mechanism proxies
    HTTPS straight to the legacy box's port 443 (Caddy), which turned out
    to be structurally broken (Caddy is strict SNI-based virtual hosting
    with no fallback certificate, and GCP's Internet NEG has no way to
    send a bare-IP backend a custom TLS SNI — confirmed live, 2026-08-27,
    as a reproducible 502). This mechanism instead bypasses Caddy
    entirely and talks plain HTTP straight to the app's own ports (see
    var.legacy_fallback_origin, and the backend services in lb.tf) — no
    TLS/SNI involved on that leg at all, so the same problem can't recur.
    That only works for a single specific app (its own dedicated
    ports), which is why this is a single domain, not a list like
    var.legacy_domains.

    Gets its own host_rule + path_matcher, entirely independent of "main"
    — this domain currently shares "main" with var.domain (the preview
    domain) via var.additional_domains, and an earlier version of the
    unrelated var.legacy_active mechanism taught the lesson that a shared
    toggle risks affecting domains you didn't intend to touch (see that
    variable's own history). This one only ever affects
    var.legacy_fallback_domain.

    Included on the managed cert whenever set, same as var.domain/
    additional_domains — so its DNS needs to already resolve here before
    this can be populated, same caution as always. Leave "" (the
    default) to skip entirely.
  EOT
  type        = string
  default     = ""
}

variable "legacy_fallback_origin" {
  description = <<-EOT
    External IP of the legacy box's app itself (not its Caddy/443
    listener) — see var.legacy_fallback_domain for the full mechanism
    and why this bypasses Caddy/TLS entirely rather than routing through
    it. Leave "" (the default) to skip entirely — no backend/NEG gets
    created.
  EOT
  type        = string
  default     = ""
}

variable "legacy_fallback_active" {
  description = <<-EOT
    When true (and both var.legacy_fallback_origin is set and
    var.legacy_fallback_domain is non-empty), routes
    var.legacy_fallback_domain's /v1/* and /socket.io/* traffic to the
    legacy app directly (plain HTTP, its own ports — see lb.tf) instead
    of this app's own api/websocket backends. The fallback route (neither
    path) always goes to the same frontend/Vercel backend regardless —
    that half never needs reverting, and isn't affected by this toggle
    either way.

    Defaults false: var.legacy_fallback_domain (if set) gets this app's
    own normal split-routing behavior. The backend/NEGs still get created
    whenever legacy_fallback_origin is set even with this false, so
    they're immediately switchable and testable without a second apply —
    same reasoning as var.legacy_active.
  EOT
  type        = bool
  default     = false
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
