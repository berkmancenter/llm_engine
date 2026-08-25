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

  /* Every instance here has no external IP, so ALL outbound traffic - LLM provider APIs
     above all, plus Artifact Registry and Google APIs - leaves through this NAT. GCP's
     default allocation is 64 ports per VM, and because endpoint-independent mapping is
     off, each concurrent connection to a distinct destination consumes its own port. 64
     concurrent outbound connections per instance is far too few for a web tier whose
     request handling fans out to an LLM API.

     This is not theoretical: during a 2026-08-19 load test the NAT reported
     port_usage at 64/64 with 228 dropped packets, and even a near-idle run sat at
     63/64 with 50 drops. Dropped egress packets show up as request timeouts, which is
     the most likely explanation for the chat timeouts observed in the same runs
     (49 timeouts, one taking the full 60s to fail).

     Dynamic port allocation lets a busy instance scale up from min to max as it needs
     ports, instead of every instance being permanently capped at the default. Set the
     floor well above 64 so the common case never queues, and a ceiling that still lets
     one NAT IP serve a reasonable number of VMs (each IP has 64512 usable ports; at a
     4096 ceiling that is 15 instances per IP, and nat_ip_allocate_option = AUTO_ONLY
     adds IPs as needed). */
  enable_dynamic_port_allocation = true
  min_ports_per_vm               = 512
  max_ports_per_vm               = 4096

  /* Surface exhaustion instead of having to infer it from timeouts. Without this the
     only signal is the aggregate router metric, which does not say which instance ran
     out. */
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
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

# --- Firewall: GCP health checks + LB proxy -> archive-wiki-vm ---
# Same shape as lb_to_web_server above, for the standalone VM the
# archive-wiki-vm module creates: it's a direct LB backend (via a zonal
# GCE_VM_IP_PORT NEG, not a MIG), so it needs the same health-check/proxy
# source ranges allowed in, just on its own port and tag.

resource "google_compute_firewall" "lb_to_archive_wiki_vm" {
  project       = var.project_id
  name          = "${var.network_name}-lb-to-archive-wiki-vm"
  network       = google_compute_network.vpc.id
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = distinct(concat(var.health_check_source_ranges, var.lb_proxy_source_ranges))
  target_tags   = ["archive-wiki-vm"]
  allow {
    protocol = "tcp"
    ports    = [tostring(var.archive_wiki_vm_port)]
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

# --- Firewall: web server -> standalone mongo-vm, internal only (opt-in) ---
# Only relevant if you're using the mongo-vm module instead of Atlas — see
# enable_mongo_vm_firewall's description.

resource "google_compute_firewall" "web_server_to_mongo_vm" {
  count       = var.enable_mongo_vm_firewall ? 1 : 0
  project     = var.project_id
  name        = "${var.network_name}-web-server-to-mongo-vm"
  network     = google_compute_network.vpc.id
  direction   = "INGRESS"
  priority    = 1000
  source_tags = ["web-server"]
  target_tags = ["mongo-vm"]
  allow {
    protocol = "tcp"
    ports    = [tostring(var.mongo_vm_port)]
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
