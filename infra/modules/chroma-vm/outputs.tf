output "instance_self_link" {
  value = google_compute_instance.chroma.self_link
}

output "instance_name" {
  value = google_compute_instance.chroma.name
}

output "internal_ip" {
  value = google_compute_instance.chroma.network_interface[0].network_ip
}

output "chroma_url" {
  description = "Internal URL the web servers should use for CHROMA_DB_URL."
  value       = "http://${google_compute_instance.chroma.network_interface[0].network_ip}:${var.chroma_port}"
}

output "snapshot_policy_name" {
  description = "GCP resource policy name for the data disk's scheduled snapshots — useful for `gcloud compute resource-policies describe`."
  value       = module.data_disk_snapshot.policy_name
}
