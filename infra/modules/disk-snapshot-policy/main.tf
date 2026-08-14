# The one scheduled-snapshot strategy every stateful disk in this infra
# uses — factored out so it's wired up identically everywhere instead of
# hand-copied per caller and liable to drift (different retention, a
# forgotten attachment, etc.). Callers (chroma-vm, mongo-vm) each decide
# *whether* their disk needs this and what, if anything, runs on top of it
# at the application level (mongo-vm's mongodump cron, for one) — this
# module only knows how to schedule and retain snapshots for a single disk.

resource "google_compute_resource_policy" "snapshot" {
  project = var.project_id
  region  = var.region
  name    = var.policy_name

  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = format("%02d:00", var.snapshot_hour_utc)
      }
    }

    retention_policy {
      max_retention_days    = var.retention_days
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }

    snapshot_properties {
      labels = var.labels
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "snapshot" {
  project = var.project_id
  zone    = var.zone
  disk    = var.disk_name
  name    = google_compute_resource_policy.snapshot.name
}
