output "dashboard_id" {
  value = google_monitoring_dashboard.overview.id
}

output "budget_id" {
  value = google_billing_budget.project_budget.id
}
