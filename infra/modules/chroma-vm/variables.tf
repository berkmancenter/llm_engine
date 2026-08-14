variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  description = "Zone within region for the single Chroma instance."
  type        = string
  default     = "us-central1-a"
}

variable "subnet_self_link" {
  description = "Self link of the subnet (from the network module) to attach the instance to."
  type        = string
}

variable "network_tag" {
  description = "Network tag applied so the network module's firewall rules match this instance."
  type        = string
  default     = "chroma-vm"
}

variable "iap_ssh_tag" {
  description = "Network tag that allows IAP SSH tunneling to this instance."
  type        = string
  default     = "iap-ssh"
}

variable "machine_type" {
  type    = string
  default = "n2d-standard-2"
}

variable "chroma_image" {
  description = "ChromaDB container image to run."
  type        = string
  default     = "chromadb/chroma:0.6.3"
}

variable "chroma_port" {
  type    = number
  default = 8000
}

variable "data_disk_size_gb" {
  description = <<-EOT
    Size of the persistent SSD holding Chroma's index. Chroma data here is
    considered temporary/rebuildable (see module README), so this only needs
    headroom over your current index size, not long-term growth margin —
    check your own index size before trusting this default.
  EOT
  type        = number
  default     = 20
}

variable "boot_disk_size_gb" {
  description = <<-EOT
    OS boot disk only — Chroma's actual data lives on the separate attached
    disk above, so this just needs room for the OS + Docker + the Chroma
    container image, not app data.
  EOT
  type    = number
  default = 20
}

variable "boot_disk_image" {
  type    = string
  default = "debian-cloud/debian-12"
}

variable "snapshot_hour_utc" {
  description = <<-EOT
    Hour (0-23, UTC) GCP's scheduled snapshot policy targets for the data
    disk. Same disk-snapshot-policy module, and the same default hour and
    retention, as mongo-vm's data disk snapshot — see infra/README.md's
    "Disk snapshots" section for why every stateful disk in this infra
    shares one strategy. Unlike mongo-vm's, this one isn't staggered after
    anything — there's no application-level dump step for Chroma to wait
    on, just the snapshot itself.
  EOT
  type        = number
  default     = 4
}

variable "snapshot_retention_days" {
  description = "How many daily snapshots to retain — same default as mongo-vm's data disk."
  type        = number
  default     = 7
}

variable "labels" {
  type    = map(string)
  default = {}
}
