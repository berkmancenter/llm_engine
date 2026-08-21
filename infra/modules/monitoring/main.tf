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

locals {
  # Base widget set, always present.
  dashboard_widgets_base = [
    {
      title = "Web server MIG — instance count"
      xyChart = {
        dataSets = [{
          timeSeriesQuery = {
            timeSeriesFilter = {
              filter      = "resource.type=\"instance_group\" AND resource.label.\"instance_group_name\"=\"${var.mig_name}\" AND metric.type=\"compute.googleapis.com/instance_group/size\""
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
              filter      = "resource.type=\"gce_instance\" AND metadata.user_labels.\"component\"=\"web-server\" AND metric.type=\"compute.googleapis.com/instance/cpu/utilization\""
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
              filter      = "metric.type=\"custom.googleapis.com/app/concurrent_connections\""
              aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
            }
          }
        }]
      }
    },
    {
      title = "Web server LB — 5xx response rate"
      xyChart = {
        dataSets = [{
          timeSeriesQuery = {
            timeSeriesFilter = {
              filter      = "resource.type=\"https_lb_rule\" AND metric.type=\"loadbalancing.googleapis.com/https/request_count\" AND metric.label.\"response_code_class\"=\"500\""
              aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_SUM", crossSeriesReducer = "REDUCE_SUM" }
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
              filter      = "resource.type=\"gce_instance\" AND resource.label.\"instance_id\"!=\"\" AND metadata.system_labels.\"name\"=\"${var.chroma_instance_name}\" AND metric.type=\"compute.googleapis.com/instance/cpu/utilization\""
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
              filter      = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.chroma_instance_name}\" AND metric.type=\"agent.googleapis.com/memory/percent_used\""
              aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
            }
          }
        }]
      }
    },
    {
      title = "Chroma VM — data disk utilization (ops agent)"
      xyChart = {
        dataSets = [{
          timeSeriesQuery = {
            timeSeriesFilter = {
              filter      = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.chroma_instance_name}\" AND metric.type=\"agent.googleapis.com/disk/percent_used\" AND metric.label.\"state\"=\"used\""
              aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
            }
          }
        }]
      }
    }
  ]

  # Mongo-vm widgets only make sense when mongo-vm is the backend in use —
  # on Atlas there's no VM here to chart. See mongo_instance_name's
  # description.
  dashboard_widgets_mongo = var.mongo_instance_name == null ? [] : [
    {
      title = "Mongo VM — CPU utilization"
      xyChart = {
        dataSets = [{
          timeSeriesQuery = {
            timeSeriesFilter = {
              filter      = "resource.type=\"gce_instance\" AND resource.label.\"instance_id\"!=\"\" AND metadata.system_labels.\"name\"=\"${var.mongo_instance_name}\" AND metric.type=\"compute.googleapis.com/instance/cpu/utilization\""
              aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
            }
          }
        }]
      }
    },
    {
      title = "Mongo VM — memory utilization (ops agent)"
      xyChart = {
        dataSets = [{
          timeSeriesQuery = {
            timeSeriesFilter = {
              filter      = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.mongo_instance_name}\" AND metric.type=\"agent.googleapis.com/memory/percent_used\""
              aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
            }
          }
        }]
      }
    },
    {
      title = "Mongo VM — data disk utilization (ops agent)"
      xyChart = {
        dataSets = [{
          timeSeriesQuery = {
            timeSeriesFilter = {
              filter      = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.mongo_instance_name}\" AND metric.type=\"agent.googleapis.com/disk/percent_used\" AND metric.label.\"state\"=\"used\""
              aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN" }
            }
          }
        }]
      }
    }
  ]
}

resource "google_monitoring_dashboard" "overview" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "llm_engine — split infra overview"
    gridLayout = {
      widgets = concat(local.dashboard_widgets_base, local.dashboard_widgets_mongo)
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
        alignment_period = "300s"
        # compute.googleapis.com/instance_group/size is a GAUGE/INT64 metric —
        # ALIGN_DELTA (rate-of-change aligners) only applies to DELTA/CUMULATIVE
        # metrics and was rejected outright by the API. ALIGN_MAX catches any
        # spike above min_replicas within each 5-minute window instead.
        per_series_aligner = "ALIGN_MAX"
      }
      trigger {
        # NOTE: this filter matches one specific instance_group_name, so
        # there's only ever one time series — `count` here is "how many
        # series must violate simultaneously," which a single-series filter
        # can never satisfy at count=3. Left as-is (not the bug this fix
        # targets); revisit alongside the threshold/duration tuning already
        # flagged above once real traffic data exists.
        count = 3
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
  # agent.googleapis.com/memory/percent_used — now installed by
  # chroma-vm's startup script, with a dedicated service account so its
  # writes actually authenticate (see chroma-vm/main.tf). Prior to both of
  # those existing, this alert could never fire.
}

# --- Alert: Chroma VM data disk pressure ---

resource "google_monitoring_alert_policy" "chroma_disk_pressure" {
  project      = var.project_id
  display_name = "llm-engine: Chroma VM data disk pressure"
  combiner     = "OR"
  conditions {
    display_name = "Data disk utilization > 85% for 5m"
    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.chroma_instance_name}\" AND metric.type=\"agent.googleapis.com/disk/percent_used\" AND metric.label.\"state\"=\"used\""
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
}

# --- Alert: Mongo VM memory pressure (parity with Chroma's) ---
# count-gated: mongo_instance_name is null when running on Atlas instead.

resource "google_monitoring_alert_policy" "mongo_memory_pressure" {
  count        = var.mongo_instance_name == null ? 0 : 1
  project      = var.project_id
  display_name = "llm-engine: Mongo VM memory pressure"
  combiner     = "OR"
  conditions {
    display_name = "Memory utilization > 85% for 5m"
    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.mongo_instance_name}\" AND metric.type=\"agent.googleapis.com/memory/percent_used\""
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
}

# --- Alert: Mongo VM data disk pressure ---
# mongo-data holds both mongod's live dbpath and the mongodump archives
# (see mongo-vm/variables.tf's data_disk_size_gb) — a full disk breaks
# both writes and backups at once, so this threshold matters more here
# than on Chroma's rebuildable data.

resource "google_monitoring_alert_policy" "mongo_disk_pressure" {
  count        = var.mongo_instance_name == null ? 0 : 1
  project      = var.project_id
  display_name = "llm-engine: Mongo VM data disk pressure"
  combiner     = "OR"
  conditions {
    display_name = "Data disk utilization > 85% for 5m"
    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.mongo_instance_name}\" AND metric.type=\"agent.googleapis.com/disk/percent_used\" AND metric.label.\"state\"=\"used\""
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
}

# --- Alert: scheduled disk-snapshot failure (any disk, project-wide) ---
#
# Real precedent (2026-08-20): both mongo-vm's and chroma-vm's scheduled
# snapshot policies failed silently every day for a week (a
# resourceLocations org-policy violation — see disk-snapshot-policy's
# storage_locations fix) before anyone noticed; the only reason it
# surfaced was a manual `gcloud logging read`. This is the fast-signal
# half of closing that gap: it fires within minutes of any scheduled-
# snapshot failure, on the exact log filter that surfaced the original
# incident.
#
# Deliberately project-wide, not per-disk: the ScheduledSnapshots log
# entry's only disk-identifying field is a numeric resource.labels.disk_id
# that Terraform can't reference without an extra data lookup, and the
# auto-generated snapshot name's disk-name prefix is truncated by an
# undocumented GCP rule — not safe to hardcode a match against. If this
# fires, `gcloud compute snapshots list` / a `gcloud logging read` (see
# llm_engine-infra's CLAUDE.md for the exact filter) identifies which disk.
resource "google_monitoring_alert_policy" "scheduled_snapshot_failure" {
  project      = var.project_id
  display_name = "llm-engine: scheduled disk snapshot failed"
  combiner     = "OR"
  conditions {
    display_name = "ScheduledSnapshots logged an error"
    condition_matched_log {
      filter = "resource.type=\"gce_disk\" AND protoPayload.methodName=\"ScheduledSnapshots\" AND severity=\"ERROR\""
    }
  }
  notification_channels = var.notification_channels
}

# --- Alert: scheduled disk-snapshot silence (no attempt logged at all) ---
#
# Complements the alert above: catches a policy that stops running
# entirely — detached from its disk, deleted outright, or blocked in a way
# that never logs under the filter above — rather than one that runs and
# errors. Same project-wide caveat as above: this only proves *some*
# scheduled-snapshot activity happened project-wide in the window, not
# that both disks individually succeeded.
resource "google_logging_metric" "scheduled_snapshot_activity" {
  project = var.project_id
  name    = "llm-engine-scheduled-snapshot-activity"
  filter  = "resource.type=\"gce_disk\" AND protoPayload.methodName=\"ScheduledSnapshots\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "scheduled_snapshot_silence" {
  project      = var.project_id
  display_name = "llm-engine: no scheduled snapshot activity in 26h"
  combiner     = "OR"
  conditions {
    display_name = "Zero ScheduledSnapshots log entries in 26h"
    condition_absent {
      # No resource.type clause: a log-based counter metric with no label
      # extractors materializes under Cloud Monitoring's own default
      # resource type (typically "global"), not the log entries' own
      # resource.type — asserting gce_disk here risked the filter never
      # matching anything and the "absence" condition being permanently
      # (falsely) true from the moment it's created. Verify the actual
      # resource type once real data exists and tighten this filter if
      # useful.
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.scheduled_snapshot_activity.name}\""
      duration = "93600s" # 26h: one day's cadence plus GCP's up-to-1h scheduling slack
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }
  notification_channels = var.notification_channels
}

# --- Alert: mongo-vm's mongodump backup cron failed ---
# See mongo-vm/startup-script.sh.tpl's MONGO_BACKUP_FAIL marker.

resource "google_monitoring_alert_policy" "mongo_backup_failure" {
  count        = var.mongo_instance_name == null ? 0 : 1
  project      = var.project_id
  display_name = "llm-engine: mongodump backup cron failed"
  combiner     = "OR"
  conditions {
    display_name = "MONGO_BACKUP_FAIL logged"
    condition_matched_log {
      filter = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.mongo_instance_name}\" AND (jsonPayload.message:\"MONGO_BACKUP_FAIL\" OR textPayload:\"MONGO_BACKUP_FAIL\")"
    }
  }
  notification_channels = var.notification_channels
}

# --- Alert: mongo-vm's mongodump backup cron silent (no OK in 26h) ---
# Catches the cron not running at all (Ops Agent down, cron service down,
# instance down) rather than running and failing.

resource "google_logging_metric" "mongo_backup_ok" {
  count   = var.mongo_instance_name == null ? 0 : 1
  project = var.project_id
  name    = "llm-engine-mongo-backup-ok"
  filter  = "resource.type=\"gce_instance\" AND metadata.system_labels.\"name\"=\"${var.mongo_instance_name}\" AND (jsonPayload.message:\"MONGO_BACKUP_OK\" OR textPayload:\"MONGO_BACKUP_OK\")"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "mongo_backup_silence" {
  count        = var.mongo_instance_name == null ? 0 : 1
  project      = var.project_id
  display_name = "llm-engine: no successful mongodump backup in 26h"
  combiner     = "OR"
  conditions {
    display_name = "Zero MONGO_BACKUP_OK log entries in 26h"
    condition_absent {
      # Same "no resource.type clause" reasoning as scheduled_snapshot_silence.
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.mongo_backup_ok[0].name}\""
      duration = "93600s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }
  notification_channels = var.notification_channels
}

# --- Alert: elevated 5xx rate from the load balancer ---
# Verified against the live metric descriptor (loadbalancing.googleapis.com/
# https/request_count, DELTA/INT64, response_code_class label) before
# writing this — see llm_engine-infra's CLAUDE.md for how. This also
# implicitly covers "MIG has no healthy backend": an LB with no backend to
# route to returns 502s to clients, which count as response_code_class=500
# here — confirmed empirically during the 2026-08-20 incident's recovery,
# where 502s were observed while the MIG was being recreated.
resource "google_monitoring_alert_policy" "backend_5xx_rate" {
  project      = var.project_id
  display_name = "llm-engine: elevated 5xx rate from the load balancer"
  combiner     = "OR"
  conditions {
    display_name = "5xx responses > 5/min for 5m"
    condition_threshold {
      filter          = "resource.type=\"https_lb_rule\" AND metric.type=\"loadbalancing.googleapis.com/https/request_count\" AND metric.label.\"response_code_class\"=\"500\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
  notification_channels = var.notification_channels
}

# --- Uptime check + alert: site unreachable from outside GCP ---
# A synthetic external check, independent of any GCP-internal health
# signal — it would have caught the 2026-08-20 incident's TLS/502 flapping
# in real time. Also the only practical way to alert on the managed SSL
# cert going bad: google_compute_managed_ssl_certificate has no status
# attribute exposed to Terraform (see webserver-mig's
# managed_ssl_certificate_name output comment), so an external reachability
# check stands in for cert introspection Terraform can't do directly.

resource "google_monitoring_uptime_check_config" "site" {
  project      = var.project_id
  display_name = "llm-engine: HTTPS site reachability"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.domain
    }
  }
}

resource "google_monitoring_alert_policy" "site_unreachable" {
  project      = var.project_id
  display_name = "llm-engine: site unreachable (uptime check failing)"
  combiner     = "OR"
  conditions {
    display_name = "Uptime check failing"
    condition_threshold {
      filter          = "resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.\"check_id\"=\"${google_monitoring_uptime_check_config.site.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.project_id", "resource.label.host"]
      }
      trigger {
        count = 1
      }
    }
  }
  notification_channels = var.notification_channels
}

# --- Project-wide billing budget alert ---
# google_billing_budget lives in the google-beta provider; see providers.tf.

resource "google_billing_budget" "project_budget" {
  count           = var.enable_budget ? 1 : 0
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
