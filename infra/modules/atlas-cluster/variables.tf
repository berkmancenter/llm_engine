variable "gcp_project_id" {
  type = string
}

variable "atlas_project_id" {
  description = <<-EOT
    Existing Atlas project ID — created by the GCP Marketplace subscription
    flow (manual-setup-checklist.md item 1), NOT created by this module.
    This module manages resources *within* that project (cluster, users,
    peering, backups); it never creates a mongodbatlas_project itself, to
    avoid conflicting with what the Marketplace activation already set up.
  EOT
  type        = string
}

variable "cluster_name" {
  type    = string
  default = "llm-engine-prod"
}

variable "gcp_region" {
  description = "GCP region name, used for the network peering / container."
  type        = string
  default     = "us-central1"
}

variable "atlas_region_name" {
  description = <<-EOT
    Atlas's own region enum for the GCP region above. NOT a mechanical
    transform of the GCP region name — Atlas's GCP region enums are
    inconsistently ordered (us-central1 -> CENTRAL_US, but e.g.
    us-east4 -> US_EAST_4). Verify against
    https://www.mongodb.com/docs/atlas/reference/google-gcp/ if you ever
    change gcp_region.
  EOT
  type        = string
  default     = "CENTRAL_US"
}

variable "instance_size" {
  description = "Cluster tier per the plan."
  type        = string
  default     = "M10"
}

variable "compute_autoscaling_enabled" {
  type    = bool
  default = true
}

variable "compute_max_instance_size" {
  description = <<-EOT
    Ceiling for Cluster Auto-Scaling's compute tier. Set to M20 to match the
    plan's own open item ("confirm the M20 hourly rate before any tier-bump
    budget assumptions") — i.e. this is the tier the budget alert (module
    B5) needs to be sized to actually cover.
  EOT
  type        = string
  default     = "M20"
}

variable "node_count" {
  description = "Electable node count for the single region config."
  type        = number
  default     = 3
}

variable "disk_gb_autoscaling_enabled" {
  type    = bool
  default = true
}

variable "app_database_name" {
  description = "Database the app connects to — matches MONGODB_URL's path in .env.example."
  type        = string
  default     = "llm_engine"
}

variable "app_db_username" {
  type    = string
  default = "llm_engine_app"
}

variable "atlas_cidr_block" {
  description = <<-EOT
    CIDR Atlas provisions its side of the peered network in. Must not
    overlap the GCP VPC's subnet_cidr (network module). Kept at /18 (not
    smaller) deliberately: mongodbatlas_network_container requires an
    explicit `regions` argument for GCP once the block is smaller than /18,
    which adds a GCP-region-format detail worth avoiding rather than
    guessing at.
  EOT
  type        = string
  default     = "10.8.0.0/18"
}

variable "gcp_network_name" {
  description = "Name of the GCP VPC network (network module output) — the peering target."
  type        = string
}

variable "gcp_network_self_link" {
  description = "Self link of the GCP VPC network (network module output)."
  type        = string
}

variable "gcp_vpc_cidr_block" {
  description = <<-EOT
    CIDR block of the GCP VPC/subnet being peered above (network module's
    subnet_cidr output, in llm_engine-infra) — added to Atlas's project IP
    access list, which it enforces independently of the peering connection
    itself. Without this, the peering applies cleanly but every connection
    from the VPC is refused.
  EOT
  type        = string
}

variable "backup_reference_hour_of_day" {
  type    = number
  default = 3
}

variable "backup_daily_retention_days" {
  type    = number
  default = 7
}

variable "backup_weekly_retention_weeks" {
  type    = number
  default = 4
}

variable "mongodb_url_secret_name" {
  description = "Secret Manager secret name this module writes the Atlas connection string to."
  type        = string
  default     = "llm-engine-mongodb-url"
}

variable "labels" {
  type    = map(string)
  default = {}
}
