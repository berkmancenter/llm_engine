# Primary signal: a custom Cloud Monitoring metric the app itself must emit
# (concurrent connection count). Fallback: CPU utilization. GCP's autoscaler
# doesn't blend these — it independently computes the instance count each
# signal demands and scales to whichever is HIGHER, so listing both gives
# "scale on whichever demands more" with no extra config. See:
# https://cloud.google.com/compute/docs/autoscaler/multiple-signals
#
# ⚠ Open item: the app does not currently publish
# custom.googleapis.com/app/concurrent_connections to Cloud Monitoring. Until
# that instrumentation exists in llm_engine itself, this metric block simply
# never reports data and the autoscaler falls back to cpu_utilization alone
# — not a Terraform gap, an application-code gap. Track separately.

resource "google_compute_region_autoscaler" "web_server" {
  project = var.project_id
  # Google refuses to change a regional autoscaler's target in place, so a new
  # group (new zone list) needs a new autoscaler. The hash keeps the new name
  # clear of the old one, which Terraform may still be deleting.
  name   = "llm-engine-web-autoscaler-${local.zone_list_hash}"
  region = var.region
  target = google_compute_region_instance_group_manager.web_server.id

  autoscaling_policy {
    min_replicas    = var.min_replicas
    max_replicas    = var.max_replicas
    cooldown_period = 60

    cpu_utilization {
      target = var.cpu_utilization_target
    }

    metric {
      name   = "custom.googleapis.com/app/concurrent_connections"
      type   = "GAUGE"
      target = var.concurrent_connections_target
    }
  }
}
