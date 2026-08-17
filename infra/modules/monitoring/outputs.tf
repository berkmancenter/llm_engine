output "dashboard_id" {
  value = google_monitoring_dashboard.overview.id
}

output "budget_id" {
  # null when enable_budget = false, rather than an index-out-of-range error.
  value = one(google_billing_budget.project_budget[*].id)
}
