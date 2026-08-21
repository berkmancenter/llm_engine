output "cluster_name" {
  value = mongodbatlas_advanced_cluster.this.name
}

output "mongodb_url_secret_id" {
  description = "Secret Manager secret name holding the full Atlas connection string — pass to the webserver-mig module."
  value       = google_secret_manager_secret.mongodb_url.secret_id
}

output "atlas_gcp_vpc_name" {
  description = "Atlas-side VPC name for the peering connection, for reference/debugging."
  value       = mongodbatlas_network_peering.gcp.atlas_vpc_name
}

output "network_peering_status" {
  description = "Check this is AVAILABLE before relying on the peered connection."
  value       = mongodbatlas_network_peering.gcp.status_name
}
