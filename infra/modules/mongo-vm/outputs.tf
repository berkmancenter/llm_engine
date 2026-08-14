output "instance_self_link" {
  value = google_compute_instance.mongo.self_link
}

output "instance_name" {
  value = google_compute_instance.mongo.name
}

output "internal_ip" {
  value = google_compute_instance.mongo.network_interface[0].network_ip
}

output "mongodb_url_secret_id" {
  description = <<-EOT
    Secret Manager secret name holding the full mongodb:// connection
    string — pass to the webserver-mig module's mongodb_url_secret_id,
    same as you would atlas-cluster's output of the same name.
  EOT
  value       = google_secret_manager_secret.mongodb_url.secret_id
}

output "snapshot_policy_name" {
  description = "GCP resource policy name for the data disk's scheduled snapshots — useful for `gcloud compute resource-policies describe`."
  value       = module.data_disk_snapshot.policy_name
}
