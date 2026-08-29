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
      # Without this, GCP defaults new snapshots to the "US" multi-region.
      # This project's org policy (constraints/gcp.resourceLocations) only
      # allows us-central1*/us-east4* locations, so every scheduled snapshot
      # was silently failing with a resourceLocations violation from the
      # day this policy was first attached — confirmed via
      # `gcloud logging read` showing repeated ScheduledSnapshots errors and
      # zero snapshots ever landing for either mongo-vm's or chroma-vm's
      # data disk. Pinning storage to the disk's own region keeps snapshots
      # inside the allowed locations.
      storage_locations = [var.region]
    }
  }

  # This is the only thing standing between the disk it covers and having
  # no future backups at all — protect it from an accidental
  # `terraform destroy`/replace the same way mongo-vm/chroma-vm's data
  # disks already protect themselves (see those modules' own
  # prevent_destroy). Deleting the resource doesn't touch snapshots already
  # taken (they're independent GCP objects, not tracked in state at all —
  # this module never creates a google_compute_snapshot), but it silently
  # stops the next one, forever, with nothing in a `terraform plan` output
  # calling that out as different from any other resource replacement.
  #
  # Most of this resource's fields (region, name, the whole
  # snapshot_schedule_policy block) are ForceNew, so even a deliberate
  # schedule/retention change hits this lifecycle block — that's
  # intentional, matching mongo_data/chroma_data's own tradeoff. Temporarily
  # remove this block, apply, then restore it, rather than routing around
  # it any other way.
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_disk_resource_policy_attachment" "snapshot" {
  project = var.project_id
  zone    = var.zone
  disk    = var.disk_name
  name    = google_compute_resource_policy.snapshot.name

  # Without this, detaching the policy from the disk (destroying just this
  # resource, leaving google_compute_resource_policy.snapshot's own
  # prevent_destroy untouched) achieves exactly the same outcome as
  # deleting the policy itself: this disk stops getting scheduled
  # snapshots. Protecting only the policy resource and not this attachment
  # would leave that loophole wide open.
  lifecycle {
    prevent_destroy = true
  }
}
