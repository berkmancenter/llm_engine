variable "project_id" {
  description = "GCP project ID that owns the network."
  type        = string
}

variable "region" {
  description = "Region for the subnet."
  type        = string
  default     = "us-central1"
}

variable "network_name" {
  description = "Name of the VPC network."
  type        = string
  default     = "llm-engine-vpc"
}

variable "subnet_cidr" {
  description = "Primary IPv4 CIDR range for the us-central1 subnet."
  type        = string
  default     = "10.10.0.0/20"
}

variable "web_server_port" {
  description = "TCP port the web server's HTTP API listens on inside the VM (api-port)."
  type        = number
  default     = 3000
}

variable "websocket_port" {
  description = "TCP port the web server's websocket service listens on inside the VM (ws-port)."
  type        = number
  default     = 5555
}

variable "chroma_port" {
  description = "TCP port ChromaDB listens on inside the VM."
  type        = number
  default     = 8000
}

variable "enable_mongo_vm_firewall" {
  description = <<-EOT
    Whether to open the firewall from the web server tier to a standalone
    mongo-vm instance (mongo-vm module). Leave false when running on
    Atlas (atlas-cluster module) — Atlas reaches the web servers over its
    own VPC peering, which doesn't go through this firewall at all.
  EOT
  type        = bool
  default     = false
}

variable "mongo_vm_port" {
  description = "TCP port MongoDB listens on inside the mongo-vm instance."
  type        = number
  default     = 27017
}

variable "health_check_source_ranges" {
  description = <<-EOT
    Source ranges GCP health checks originate from. These are fixed
    Google-owned ranges, not project-specific — see
    https://cloud.google.com/load-balancing/docs/health-check-concepts#ip-ranges
  EOT
  type        = list(string)
  default     = ["35.191.0.0/16", "130.211.0.0/22"]
}

variable "lb_proxy_source_ranges" {
  description = "Source ranges for the GCP global external HTTPS load balancer's proxy-to-backend traffic."
  type        = list(string)
  default     = ["35.191.0.0/16", "130.211.0.0/22"]
}
