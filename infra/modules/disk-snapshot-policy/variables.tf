variable "project_id" {
  type = string
}

variable "region" {
  description = "Region the resource policy lives in — resource policies are regional even when the disk they attach to is zonal."
  type        = string
}

variable "zone" {
  description = "Zone of the disk being snapshotted."
  type        = string
}

variable "disk_name" {
  description = "Name of the google_compute_disk to attach this snapshot schedule to."
  type        = string
}

variable "policy_name" {
  description = <<-EOT
    Name for the resource policy. Must be unique per project/region — give
    it a name derived from the disk it's for (e.g.
    "llm-engine-<component>-snapshot") so two callers in the same region
    don't collide.
  EOT
  type        = string
}

variable "snapshot_hour_utc" {
  description = "Hour (0-23, UTC) the daily snapshot schedule starts."
  type        = number
  default     = 4
}

variable "retention_days" {
  description = "How many daily snapshots to retain before GCP rotates out the oldest — at this policy's one-a-day cadence, a value of N keeps the last N snapshots."
  type        = number
  default     = 7
}

variable "labels" {
  type    = map(string)
  default = {}
}
