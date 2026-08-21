# Cloud Monitoring dashboards + alert policies (module B5) and the
# project-wide billing budget alert.
#
# ⚠ Open item, not yet implemented: an Atlas auto-scale tier-change alert.
# Atlas has its own native alerting (mongodbatlas_alert_configuration) and
# doesn't publish tier-change events into Cloud Monitoring, so this would be
# a resource in the atlas-cluster module, not here — deliberately left out
# rather than guessed at, since the exact event_type enum for "cluster tier
# changed" needs verifying against the mongodbatlas provider docs before
# it's worth committing to Terraform.

resource "google_monitoring_dashboard" "overview" {
  project        = var.project_id
  dashboard_json = jsonencode({
    displayName = "llm_engine — split infra overview"
    gridLayout = {
      widgets = [
        {
          title = "Web server MIG — instance count"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"instance_group\" AND resource.label.\"instance_group_name\"=\"${var.mig_name}\" AND metric.type=\"compute.googleapis.com/instance_group/size\""
                  aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
                }
              }
            }]
          }
        },
        {
          title = "Web server MIG — CPU utilization"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  # Matches on the "component" label the webserver-mig
                  # module applies to its instance template — there's no
                  # automatic "which MIG is this instance in" resource
                  # label on gce_instance itself.
                  filter = "resource.type=\"gce_instance\" AND metadata.user_labels.\"component\"=\"web-server\" AND metric.type=\"compute.googleapis.com/instance/cpu/utilization\""
                  aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
                }
              }
            }]
          }
        },
        {
          title = "Web server — concurrent connections (custom metric)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/app/concurrent_connections\""
                  aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
                }
              }
            }]
          }
        },
        {
          title = "Chroma VM — CPU utilization"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"gce_instance\" AND resource.label.\"instance_id\"!=\"\" AND metadata.system_labels.\"name\"=\"${var.chroma_instance_name}\" AND metric.type=\"compute.googleapis.com/instance/cpu/utilization\""
                  aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
                }
              }
            }]
          }
        },
        {
          title = "Chroma VM — memory utilization (ops agent)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.chroma_instance_name}\" AND metric.type=\"agent.googleapis.com/memory/percent_used\""
                  aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
                }
              }
            }]
          }
        }
      ]
    }
  })
}

# --- Alert: MIG scaling up frequently (possible thrashing / undersized min) ---

resource "google_monitoring_alert_policy" "mig_scale_up_frequency" {
  project      = var.project_id
  display_name = "llm-engine: web server MIG scaling up frequently"
  combiner     = "OR"
  conditions {
    display_name = "Instance group size increased repeatedly"
    condition_threshold {
      filter          = "resource.type=\"instance_group\" AND resource.label.\"instance_group_name\"=\"${var.mig_name}\" AND metric.type=\"compute.googleapis.com/instance_group/size\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1 # min replicas — see webserver-mig module; revisit once real traffic data exists
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_DELTA"
      }
      trigger {
        count = 3 # 3 scale-events within the alignment window
      }
    }
  }
  notification_channels = var.notification_channels
}

# --- Alert: Chroma VM memory pressure ---

resource "google_monitoring_alert_policy" "chroma_memory_pressure" {
  project      = var.project_id
  display_name = "llm-engine: Chroma VM memory pressure"
  combiner     = "OR"
  conditions {
    display_name = "Memory utilization > 85% for 5m"
    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.chroma_instance_name}\" AND metric.type=\"agent.googleapis.com/memory/percent_used\""
      comparison      = "COMPARISON_GT"
      threshold_value = 85
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = var.notification_channels

  # Requires the Ops Agent installed on the Chroma VM to emit
  # agent.googleapis.com/memory/percent_used — add it to the chroma-vm
  # module's startup script if this alert never fires with real data.
}

# --- Project-wide billing budget alert ---
# google_billing_budget lives in the google-beta provider; see providers.tf.

resource "google_billing_budget" "project_budget" {
  provider        = google-beta
  billing_account = var.billing_account_id
  display_name    = "llm_engine split infra — monthly budget"

  budget_filter {
    projects = ["projects/${var.project_id}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget_alert_thresholds
    content {
      threshold_percent = threshold_rules.value
    }
  }

  all_updates_rule {
    monitoring_notification_channels = var.notification_channels
    disable_default_iam_recipients   = false
  }
}
