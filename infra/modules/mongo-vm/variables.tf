variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  description = "Zone within region for the single mongo instance."
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
  default     = "mongo-vm"
}

variable "iap_ssh_tag" {
  description = "Network tag that allows IAP SSH tunneling to this instance."
  type        = string
  default     = "iap-ssh"
}

variable "machine_type" {
  description = <<-EOT
    n2d-standard-2 (2 vCPU / 4 GB RAM) is the smallest machine type this
    module has been sized for — it's the low-budget alternative to Atlas,
    not a general-purpose sizing knob. See wiredtiger_cache_size_gb before
    going smaller than this.
  EOT
  type        = string
  default     = "n2d-standard-2"
}

variable "mongo_image" {
  description = "MongoDB Docker image to run. Pin to a specific minor version deliberately (not `latest`)."
  type        = string
  default     = "mongo:7.0"
}

variable "mongo_port" {
  type    = number
  default = 27017
}

variable "data_disk_type" {
  description = <<-EOT
    pd-balanced is the budget-tier choice; use pd-ssd if write latency
    matters more than cost. Changing this on an existing deployment forces
    Terraform to destroy and recreate the disk (GCP has no in-place disk
    type change) — main.tf's prevent_destroy blocks that apply outright, so
    a real type change needs a manual snapshot-and-restore onto a new disk
    of the new type, not a plain `terraform apply`.
  EOT
  type        = string
  default     = "pd-balanced"
}

variable "data_disk_size_gb" {
  description = <<-EOT
    Size of the persistent disk holding both MongoDB's data directory and
    its local mongodump archives (see backup_retention_days) — unlike
    chroma-vm's data disk, this is NOT rebuildable/temporary, it's the
    system of record when running without Atlas. Size for real growth
    margin *plus* room for up to backup_retention_days full gzipped
    mongodump archives, not just the live dataset — at the default 30-day
    retention that's 30 archives, each roughly on the order of the live
    dataset's own size, so budget disk space accordingly rather than
    assuming this only needs headroom over current data size.
  EOT
  type        = number
  default     = 30
}

variable "boot_disk_size_gb" {
  description = "OS boot disk only — Mongo's actual data lives on the separate attached disk above."
  type        = number
  default     = 20
}

variable "boot_disk_image" {
  type    = string
  default = "debian-cloud/debian-12"
}

variable "wiredtiger_cache_size_gb" {
  description = <<-EOT
    WiredTiger's in-memory cache size, in GB. Left at 0 (auto), mongod picks
    max(256MB, (RAM - 1GB) * 0.5), which on the default n2d-standard-2 (4GB
    RAM) works out to ~1.5GB — leaving ~2.5GB for the OS, mongod's own
    overhead, and connections. Set an explicit value only if you change
    machine_type and want to reason about the same headroom yourself.
  EOT
  type        = number
  default     = 0
}

variable "app_database_name" {
  description = "Database the app connects to — matches MONGODB_URL's path in .env.example, and atlas-cluster's variable of the same name."
  type        = string
  default     = "llm_engine"
}

variable "app_db_username" {
  type    = string
  default = "llm_engine_app"
}

variable "root_username" {
  description = <<-EOT
    MongoDB root user, created once on first boot. Only needed for
    administrative access via IAP SSH + mongosh — the app itself connects
    as app_db_username with the readWrite-scoped role, not this account.
  EOT
  type        = string
  default     = "root"
}

variable "mongodb_url_secret_name" {
  description = <<-EOT
    Secret Manager secret name this module writes the connection string
    to. Defaults to the same name as atlas-cluster's variable of the same
    name, so switching between the two modules in your environments/
    config doesn't require changing webserver-mig's mongodb_url_secret_id
    wiring — only which one of these two modules you instantiate.
  EOT
  type        = string
  default     = "llm-engine-mongodb-url"
}

variable "backup_hour_utc" {
  description = "Hour (0-23, UTC) the daily mongodump cron job starts on the VM."
  type        = number
  default     = 2
}

variable "backup_retention_days" {
  description = <<-EOT
    How many days of local gzipped mongodump archives to keep on the data
    disk (see data_disk_size_gb) before the cron job prunes them. This is
    the *local* copy's retention only — snapshot_retention_days below
    governs the separate, independent retention on GCP's scheduled disk
    snapshots.
  EOT
  type        = number
  default     = 30
}

variable "snapshot_hour_utc" {
  description = <<-EOT
    Hour (0-23, UTC) GCP's scheduled snapshot policy targets for the data
    disk. Kept comfortably after backup_hour_utc (2 hours by default) for
    two reasons: mongodump itself needs time to finish, and GCP's own
    snapshot scheduler only guarantees the snapshot starts *within* an
    hour of start_time, not exactly at it — see
    https://cloud.google.com/compute/docs/disks/scheduled-snapshots.
    Widen the gap if your dataset grows enough that mongodump's runtime
    stops being trivially short.
  EOT
  type        = number
  default     = 4
}

variable "snapshot_retention_days" {
  description = <<-EOT
    How many daily snapshots GCP keeps before rotating out the oldest —
    at this policy's one-a-day cadence, a value of N keeps the last N
    snapshots. Deliberately a much shorter window than
    backup_retention_days: this is the belt-and-suspenders copy on top of
    the mongodump archives, not the primary retention story.
  EOT
  type        = number
  default     = 7
}

variable "labels" {
  type    = map(string)
  default = {}
}
