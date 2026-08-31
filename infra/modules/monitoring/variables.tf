variable "project_id" {
  type = string
}

variable "billing_account_id" {
  description = "Billing account ID that project_id is linked to (format XXXXXX-XXXXXX-XXXXXX)."
  type        = string
}

variable "enable_budget" {
  description = <<-EOT
    Whether to create the project_budget google_billing_budget resource.
    Defaults to true. Set to false when the caller's service account lacks
    the billing-account-level IAM role google_billing_budget needs (a 403
    on create, not a bug in this module) and that grant is still pending —
    e.g. llm_engine-infra's manual-setup-checklist.md item 3, blocked on
    IT as of 2026-08-17. Flip back to true (or drop the override) once that
    grant lands.
  EOT
  type        = bool
  default     = true
}

variable "budget_amount_usd" {
  description = <<-EOT
    Monthly budget threshold in USD covering the whole project — Atlas
    auto-scale tier bumps (e.g. M10 -> M20) show up as GCP Marketplace
    line items, so this budget catches those too, not just compute.
    Open item from the plan: confirm the M20 hourly rate before trusting
    this default as "won't get surprised".
  EOT
  type        = number
  default     = 500
}

variable "budget_alert_thresholds" {
  description = "Fractions of budget_amount_usd at which to notify (e.g. 0.5 = 50%)."
  type        = list(number)
  default     = [0.5, 0.9, 1.0]
}

variable "notification_channels" {
  description = <<-EOT
    List of google_monitoring_notification_channel IDs (email/Slack/etc) to
    attach to alert policies and the budget alert. Create these once by hand
    (Monitoring -> Alerting -> Notification channels) or add a
    google_monitoring_notification_channel resource of your own and pass its
    id here — left as an input rather than owned by this module since who
    gets paged is a team decision, not an infra shape decision.
  EOT
  type        = list(string)
  default     = []
}

variable "mig_name" {
  type = string
}

variable "frontend_backend_service_name" {
  description = <<-EOT
    webserver-mig's frontend backend service name (its frontend_backend_service_name
    output), used to split the 5xx alert into a frontend-proxy policy and a
    backend policy that says which tier actually erred. Null when
    var.frontend_origin is unset there - no frontend backend/NEG exists in that
    case, so only the backend policy is created (and its filter has nothing to
    exclude, since every https_lb_rule 5xx is a backend one).
  EOT
  type        = string
  default     = null
}

variable "chroma_instance_name" {
  type = string
}

variable "mongo_instance_name" {
  description = <<-EOT
    gce_instance name for mongo-vm's CPU/memory/disk dashboard widgets and
    alerts. Null when running on Atlas instead of mongo-vm — there's no VM
    to monitor this way (Atlas has its own native alerting; see the
    open-item comment at the top of main.tf).
  EOT
  type        = string
  default     = null
}

variable "archive_wiki_instance_name" {
  description = <<-EOT
    gce_instance name for archive-wiki-vm's CPU/memory/disk dashboard widgets
    and alerts. Null (the default) when this deployment doesn't run
    archive-wiki-vm at all — it's an optional add-on, not part of every
    llm_engine deployment, unlike Chroma/Mongo. Same null-means-omit pattern
    as mongo_instance_name.
  EOT
  type        = string
  default     = null
}

variable "domain" {
  description = "Public domain the uptime check hits — same value passed to webserver-mig's domain variable."
  type        = string
}

variable "region" {
  type    = string
  default = "us-central1"
}
