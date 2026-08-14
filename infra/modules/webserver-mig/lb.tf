# Global external HTTPS load balancer: path-based routing to the api-port
# and ws-port backend services on the same MIG. TLS terminates here — no
# Caddy on the instances themselves.

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

  backend {
    group = google_compute_region_instance_group_manager.web_server.instance_group
  }
}

resource "google_compute_url_map" "web_server" {
  project         = var.project_id
  name            = "llm-engine-url-map"
  default_service = google_compute_backend_service.api.id

  host_rule {
    hosts        = concat([var.domain], var.additional_domains)
    path_matcher = "main"
  }

  path_matcher {
    name            = "main"
    default_service = google_compute_backend_service.api.id

    path_rule {
      paths   = ["/socket.io/*"]
      service = google_compute_backend_service.websocket.id
    }
  }
}

locals {
  # google_compute_managed_ssl_certificate has no name_prefix argument
  # (confirmed against the actual provider schema — unlike, say, the
  # instance template above), so a content-derived suffix stands in for
  # one: the name only changes when the domain set does, which is exactly
  # when create_before_destroy below needs a fresh name to create the new
  # cert alongside the old one.
  ssl_cert_domains = concat([var.domain], var.additional_domains)
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
