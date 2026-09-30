# Internal passthrough Network Load Balancer: lets another VM on this same
# VPC (bot-media-server-vm) reach the web server MIG directly over a
# stable internal IP, without a round trip through the public HTTPS LB in
# lb.tf and without re-terminating TLS on the way back in. Plain L4
# passthrough (protocol TCP, no HTTP/L7 behavior) so the API port and the
# websocket port behave identically here — no proxy-layer WebSocket-upgrade
# handling to get subtly wrong, unlike lb.tf's proxy-based external LB.
#
# A direct instance IP isn't an option in its place: web_server's instances
# are MIG members with ephemeral IPs that come and go under autoscaling/
# rolling updates, so nothing outside the MIG can hold onto one safely.
# This backend service + forwarding rule is the stable target that takes
# its place, tracking the same instance group lb.tf's external backends do.
#
# Reuses web_server's existing HTTP health check (main.tf, GET /v1/health
# on api_port) rather than adding a third health check resource. GCP
# backend services here take exactly one health check, so this can only
# ever directly cover one of the two ports the forwarding rule serves —
# the API process going down alone without also taking the websocket
# listener with it (or vice versa) genuinely isn't caught at this LB.
# Picked the HTTP check over web_server_ws's TCP one anyway: a real
# response on /v1/health is a stronger liveness signal than a bare TCP
# accept, for whichever single port this ends up representing. The MIG's
# own auto_healing_policies (same health check) is the backstop for the
# gap either choice leaves — an API-only failure still gets the instance
# replaced, just not instantly rerouted around at the LB level first.

resource "google_compute_address" "web_server_internal" {
  project      = var.project_id
  name         = "llm-engine-web-server-internal-ip"
  region       = var.region
  subnetwork   = var.subnet_self_link
  address_type = "INTERNAL"
}

resource "google_compute_region_backend_service" "web_server_internal" {
  project               = var.project_id
  name                  = "llm-engine-web-server-internal-backend"
  region                = var.region
  protocol              = "TCP"
  load_balancing_scheme = "INTERNAL"
  health_checks         = [google_compute_health_check.web_server.id]

  backend {
    group = google_compute_region_instance_group_manager.web_server.instance_group
    # Required, not optional, for an INTERNAL-scheme backend service — GCP
    # rejects the default (UTILIZATION, meant for external/proxy LBs)
    # outright: "Balancing mode must be CONNECTION for an INTERNAL backend
    # service." No max_connections/_per_instance cap set — this fronts the
    # whole MIG, not a single small VM, so there's no equivalent to the
    # external backend's own deliberately low max_rate_per_endpoint.
    balancing_mode = "CONNECTION"
  }
}

resource "google_compute_forwarding_rule" "web_server_internal" {
  project               = var.project_id
  name                  = "llm-engine-web-server-internal-fr"
  region                = var.region
  network               = var.network_self_link
  subnetwork            = var.subnet_self_link
  ip_address            = google_compute_address.web_server_internal.id
  ip_protocol           = "TCP"
  ports                 = [tostring(var.api_port), tostring(var.ws_port)]
  load_balancing_scheme = "INTERNAL"
  backend_service       = google_compute_region_backend_service.web_server_internal.id
  allow_global_access   = false # same-region callers only (bot-media-server-vm is in this region) — no reason to widen this
}
