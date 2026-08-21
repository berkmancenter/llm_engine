# VPC + subnet(s) in us-central1, firewall rules, and NAT for private instances'
# outbound calls (LLM provider APIs, Atlas, etc). See ../../README.md for the
# overall module layout this belongs to.

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = var.network_name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "primary" {
  project                  = var.project_id
  name                     = "${var.network_name}-${var.region}"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true # lets private instances reach Google APIs (Artifact Registry, Monitoring, ...)
}

# --- Outbound internet access for instances with no external IP ---

resource "google_compute_router" "router" {
  project = var.project_id
  name    = "${var.network_name}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  project                            = var.project_id
  name                               = "${var.network_name}-nat"
  region                             = var.region
  router                             = google_compute_router.router.name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# --- Firewall: explicit deny-all ingress baseline (documents intent; the
#     implied VPC rule already denies anything not explicitly allowed below) ---

resource "google_compute_firewall" "deny_all_ingress" {
  project   = var.project_id
  name      = "${var.network_name}-deny-all-ingress"
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  priority  = 65534
  deny {
    protocol = "all"
  }
  source_ranges = ["0.0.0.0/0"]
}

# --- Firewall: GCP health checks + LB proxy -> web server MIG (serving ports) ---

resource "google_compute_firewall" "lb_to_web_server" {
  project       = var.project_id
  name          = "${var.network_name}-lb-to-web-server"
  network       = google_compute_network.vpc.id
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = distinct(concat(var.health_check_source_ranges, var.lb_proxy_source_ranges))
  target_tags   = ["web-server"]
  allow {
    protocol = "tcp"
    ports    = [tostring(var.web_server_port), tostring(var.websocket_port)]
  }
}

# --- Firewall: web server -> Chroma VM, internal only, Chroma's port only ---

resource "google_compute_firewall" "web_server_to_chroma" {
  project     = var.project_id
  name        = "${var.network_name}-web-server-to-chroma"
  network     = google_compute_network.vpc.id
  direction   = "INGRESS"
  priority    = 1000
  source_tags = ["web-server"]
  target_tags = ["chroma-vm"]
  allow {
    protocol = "tcp"
    ports    = [tostring(var.chroma_port)]
  }
}

# --- Firewall: SSH via IAP tunnel only (no public SSH) ---
# Google-owned range for Identity-Aware Proxy TCP forwarding; see
# https://cloud.google.com/iap/docs/using-tcp-forwarding#configuring_firewall_rules

resource "google_compute_firewall" "iap_ssh" {
  project       = var.project_id
  name          = "${var.network_name}-iap-ssh"
  network       = google_compute_network.vpc.id
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["iap-ssh"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
