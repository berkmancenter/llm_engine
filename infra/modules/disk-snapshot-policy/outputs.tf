output "policy_name" {
  description = "GCP resource policy name — useful for `gcloud compute resource-policies describe`."
  value       = google_compute_resource_policy.snapshot.name
}
