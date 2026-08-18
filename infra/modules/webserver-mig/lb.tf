# Global external HTTPS load balancer: path-based routing to the api-port
# and ws-port backend services on the same MIG, plus (optionally) an
# external frontend origin as the fallback route — see "frontend proxy"
# below. TLS terminates here — no Caddy on the instances themselves. This
# mirrors the previous single-box Caddyfile's handle blocks: /v1/* ->
# api, /socket.io/* -> websocket, fallback -> the FE origin with its Host
# header rewritten.

resource "google_compute_backend_service" "api" {
  project                         = var.project_id
  name                            = "llm-engine-api-backend"
  protocol                        = "HTTP"
  port_name                       = "api-port"
  load_balancing_scheme           = "EXTERNAL_MANAGED"
  timeout_sec                     = 30
  health_checks                   = [google_compute_health_check.web_server.id]
  connection_draining_timeout_sec = var.connection_draining_timeout_sec

  backend {
    group = google_compute_region_instance_group_manager.web_server.instance_group
  }
}

resource "google_compute_backend_service" "websocket" {
  project                         = var.project_id
  name                            = "llm-engine-ws-backend"
  protocol                        = "HTTP"
  port_name                       = "ws-port"
  load_balancing_scheme           = "EXTERNAL_MANAGED"
  timeout_sec                     = 3600 # long-lived websocket connections
  health_checks                   = [google_compute_health_check.web_server.id]
  connection_draining_timeout_sec = var.connection_draining_timeout_sec

  # Socket.IO's handshake is several plain HTTP requests (polling transport
  # negotiation, then the websocket upgrade) before the connection is actually
  # established - without affinity those can land on different instances
  # mid-handshake and fail. GENERATED_COOKIE has the LB inject a cookie on the
  # first response and route every later request carrying it to the same
  # instance; a k6 websocket-stampede load test against preview confirmed this
  # was live-dropping connections (605/1000 unexpected closes, 51 connect
  # errors) with 2 healthy instances up and no scaling event in progress - see
  # k6/README.md. TTL matches this backend's own timeout_sec so an affinity
  # cookie outlives any single connection's lifetime.
  session_affinity        = "GENERATED_COOKIE"
  affinity_cookie_ttl_sec = 3600

  backend {
    group = google_compute_region_instance_group_manager.web_server.instance_group
  }
}

locals {
  # Everything not matched by the path_rules below (i.e. not /v1/* or
  # /socket.io/*) falls through to this. With frontend_origin unset, that's
  # the api backend (its own 404 handler), same behavior as before the
  # frontend proxy existed.
  default_backend_service_id = (
    var.frontend_origin != "" ? google_compute_backend_service.frontend[0].id : google_compute_backend_service.api.id
  )
}

resource "google_compute_url_map" "web_server" {
  project         = var.project_id
  name            = "llm-engine-url-map"
  default_service = local.default_backend_service_id

  host_rule {
    hosts        = concat([var.domain], var.additional_domains)
    path_matcher = "main"
  }

  path_matcher {
    name            = "main"
    default_service = local.default_backend_service_id

    path_rule {
      paths   = ["/socket.io/*"]
      service = google_compute_backend_service.websocket.id
    }

    path_rule {
      paths   = ["/v1/*"]
      service = google_compute_backend_service.api.id
    }
  }
}

# --- Frontend proxy (optional) ---
#
# Proxies the fallback route (anything not /v1/* or /socket.io/*) to an
# external frontend origin — e.g. a Vercel deployment — through this same
# LB/domain, the same role the old single-box Caddyfile's `handle {
# reverse_proxy https://... }` fallback block played. Implemented as a
# global "internet NEG" (network_endpoint_type = INTERNET_FQDN_PORT): the
# LB makes an outbound HTTPS connection to frontend_origin for every
# request that reaches this backend, no VPC networking or health checks
# involved (GCP doesn't support health checks on internet NEGs — the
# backend is treated as always up).
#
# custom_request_headers rewrites the Host header the origin actually
# sees to frontend_origin itself, regardless of what domain the client
# requested (var.domain / additional_domains) — needed because Vercel (and
# most host-based routers) picks which deployment to serve by Host header,
# and would otherwise see this LB's own domain and not know which project
# to serve.
resource "google_compute_global_network_endpoint_group" "frontend" {
  count                 = var.frontend_origin != "" ? 1 : 0
  project               = var.project_id
  name                  = "llm-engine-frontend-neg"
  network_endpoint_type = "INTERNET_FQDN_PORT"
  default_port          = 443
}

resource "google_compute_global_network_endpoint" "frontend" {
  count                         = var.frontend_origin != "" ? 1 : 0
  global_network_endpoint_group = google_compute_global_network_endpoint_group.frontend[0].id
  fqdn                          = var.frontend_origin
  port                          = 443
}

resource "google_compute_backend_service" "frontend" {
  count                  = var.frontend_origin != "" ? 1 : 0
  project                = var.project_id
  name                   = "llm-engine-frontend-backend"
  protocol               = "HTTPS"
  load_balancing_scheme  = "EXTERNAL_MANAGED"
  timeout_sec            = 30
  custom_request_headers = ["Host: ${var.frontend_origin}"]

  backend {
    group = google_compute_global_network_endpoint_group.frontend[0].id
  }
}

locals {
  # google_compute_managed_ssl_certificate has no name_prefix argument
  # (confirmed against the actual provider schema — unlike, say, the
  # instance template above), so a content-derived suffix stands in for
  # one: the name only changes when the domain set does, which is exactly
  # when create_before_destroy below needs a fresh name to create the new
  # cert alongside the old one.
  #
  # sort(distinct(...)) rather than a bare concat, because "the domain set
  # does" has to mean the SET. Both the name hash below and managed.domains
  # read this local, and both force replacement — so without normalizing
  # here, merely reordering var.additional_domains, or listing a domain
  # twice, renames and replaces the cert while the LB goes on serving the
  # exact same hosts. That trade is never worth taking: a replaced managed
  # cert serves no TLS for ANY host on it until Google revalidates every
  # SAN (up to ~60 minutes, and unbounded if one SAN's DNS doesn't point at
  # this LB yet). Normalizing makes the cheap, reversible edit — tidying the
  # domain list — actually cheap.
  #
  # Order carries no meaning to GCP here: managed.domains is a SAN set, and
  # Google picks the certificate's CN itself rather than honoring the first
  # entry. So sorting costs nothing semantically.
  ssl_cert_domains = sort(distinct(concat([var.domain], var.additional_domains)))
}

resource "google_compute_managed_ssl_certificate" "web_server" {
  project = var.project_id
  name    = "llm-engine-cert-${substr(md5(join(",", local.ssl_cert_domains)), 0, 8)}"

  managed {
    domains = local.ssl_cert_domains
  }

  # A managed cert's domains list forces replacement (Google doesn't support
  # updating it in place) — without create_before_destroy, Terraform tries
  # to delete the old cert before the new one exists, which GCP rejects
  # outright while the https proxy below still references it
  # (resourceInUseByAnotherResource).
  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_target_https_proxy" "web_server" {
  project          = var.project_id
  name             = "llm-engine-https-proxy"
  url_map          = google_compute_url_map.web_server.id
  ssl_certificates = [google_compute_managed_ssl_certificate.web_server.id]
}

resource "google_compute_global_address" "web_server" {
  project = var.project_id
  name    = "llm-engine-lb-ip"
  labels  = var.labels
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "llm-engine-https-forwarding-rule"
  ip_address            = google_compute_global_address.web_server.address
  ip_protocol           = "TCP"
  port_range            = "443"
  target                = google_compute_target_https_proxy.web_server.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  labels                = var.labels
}

# --- HTTP -> HTTPS redirect ---

resource "google_compute_url_map" "http_redirect" {
  project = var.project_id
  name    = "llm-engine-http-redirect"

  default_url_redirect {
    https_redirect = true
    strip_query    = false
  }
}

resource "google_compute_target_http_proxy" "http_redirect" {
  project = var.project_id
  name    = "llm-engine-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project_id
  name                  = "llm-engine-http-forwarding-rule"
  ip_address            = google_compute_global_address.web_server.address
  ip_protocol           = "TCP"
  port_range            = "80"
  target                = google_compute_target_http_proxy.http_redirect.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  labels                = var.labels
}
