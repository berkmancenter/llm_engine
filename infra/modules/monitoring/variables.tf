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
  type    = list(string)
  default = []
}

variable "mig_name" {
  type = string
}

variable "chroma_instance_name" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}
