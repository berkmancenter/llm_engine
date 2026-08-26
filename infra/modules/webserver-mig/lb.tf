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
  health_checks                   = [google_compute_health_check.web_server_ws.id]
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

  # Gated on legacy_origin != "" too, defensively, so this can never
  # reference backend_service.legacy[0] when that resource doesn't exist
  # (count = 0).
  legacy_routing_active = var.legacy_active && var.legacy_origin != "" && length(var.legacy_domains) > 0

  # var.legacy_domains' own default_service/path rules — the same
  # api/websocket/frontend split "main" uses when legacy_routing_active is
  # false, or entirely the legacy backend when true. Deliberately separate
  # locals from "main"'s below — see var.legacy_domains' own description
  # for why "main" must never reference these.
  legacy_domains_default_service_id = (
    local.legacy_routing_active ? google_compute_backend_service.legacy[0].id : local.default_backend_service_id
  )
  legacy_domains_websocket_service_id = (
    local.legacy_routing_active ? google_compute_backend_service.legacy[0].id : google_compute_backend_service.websocket.id
  )
  legacy_domains_api_service_id = (
    local.legacy_routing_active ? google_compute_backend_service.legacy[0].id : google_compute_backend_service.api.id
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

  # var.legacy_domains' own host_rule + path_matcher — same api/websocket
  # split shape as "main" above, but entirely independent of it: none of
  # these domains are ever part of concat([var.domain],
  # var.additional_domains), and "main"'s own default_service/path rules
  # above never reference anything legacy-related. See var.legacy_domains'
  # description for why. All of var.legacy_domains share this one
  # host_rule/path_matcher (and so one shared legacy_active toggle) rather
  # than getting one each, the way extra_host_backends' entries do below —
  # built for a set of domains that should all cut over together, not
  # independently.
  #
  # for_each is a 0-or-1 sentinel ([1] or []), not one iteration per
  # domain — var.legacy_domains is read directly inside content below.
  dynamic "host_rule" {
    for_each = length(var.legacy_domains) > 0 ? [1] : []
    content {
      hosts        = var.legacy_domains
      path_matcher = "legacy-domains"
    }
  }

  dynamic "path_matcher" {
    for_each = length(var.legacy_domains) > 0 ? [1] : []
    content {
      name            = "legacy-domains"
      default_service = local.legacy_domains_default_service_id

      path_rule {
        paths   = ["/socket.io/*"]
        service = local.legacy_domains_websocket_service_id
      }

      path_rule {
        paths   = ["/v1/*"]
        service = local.legacy_domains_api_service_id
      }
    }
  }

  # One host_rule + single-service path_matcher per extra_host_backends
  # entry — the whole domain goes to that one backend, no path splitting
  # (unlike "main" above, which is this app's own /v1*//socket.io* split).
  # path_matcher names must be unique on one url_map, hence the index
  # suffix; nothing reads these names besides the host_rule right below it.
  dynamic "host_rule" {
    for_each = var.extra_host_backends
    content {
      hosts        = host_rule.value.domains
      path_matcher = "extra-${host_rule.key}"
    }
  }

  dynamic "path_matcher" {
    for_each = var.extra_host_backends
    content {
      name            = "extra-${path_matcher.key}"
      default_service = path_matcher.value.backend_service_id
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

# --- Legacy box passthrough (optional) ---
#
# Fronts an existing, independently-TLS-terminating legacy deployment
# through this same LB/static IP, entirely bypassing this app's own
# api/websocket/frontend split for var.legacy_domains specifically when
# var.legacy_active is true — see that variable, var.legacy_domains, and
# local.legacy_routing_active above. Modeled on the frontend proxy above
# (global Internet NEG, no VPC networking or health checks — GCP doesn't
# support health checks on internet NEGs, the backend is treated as
# always up), except INTERNET_IP_PORT (a bare IP, not a hostname) since
# var.legacy_origin is an IP address, not an FQDN.
#
# No custom_request_headers Host rewrite, unlike the frontend backend
# above — deliberately: var.legacy_domains can hold several different
# domains sharing this one backend (each with its own vhost on the legacy
# box), so there's no single fixed value to rewrite to that would be
# correct for all of them. Left unset, GCP's LB passes the client's
# original Host header straight through unmodified, which is exactly what
# each domain's own vhost match on the legacy box needs to see.
resource "google_compute_global_network_endpoint_group" "legacy" {
  count                 = var.legacy_origin != "" ? 1 : 0
  project               = var.project_id
  name                  = "llm-engine-legacy-neg"
  network_endpoint_type = "INTERNET_IP_PORT"
  default_port          = 443
}

resource "google_compute_global_network_endpoint" "legacy" {
  count                         = var.legacy_origin != "" ? 1 : 0
  global_network_endpoint_group = google_compute_global_network_endpoint_group.legacy[0].id
  ip_address                    = var.legacy_origin
  port                          = 443
}

resource "google_compute_backend_service" "legacy" {
  count                 = var.legacy_origin != "" ? 1 : 0
  project               = var.project_id
  name                  = "llm-engine-legacy-backend"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 30

  backend {
    group = google_compute_global_network_endpoint_group.legacy[0].id
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
  ssl_cert_domains = sort(distinct(concat(
    [var.domain],
    var.additional_domains,
    flatten(var.extra_host_backends[*].domains),
    var.legacy_domains
  )))
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
