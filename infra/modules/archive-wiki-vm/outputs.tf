output "instance_name" {
  value = google_compute_instance.archive_wiki.name
}

output "internal_ip" {
  value = google_compute_instance.archive_wiki.network_interface[0].network_ip
}

output "backend_service_id" {
  description = "Pass into webserver-mig's extra_host_backends to front this VM through the shared LB."
  value       = google_compute_backend_service.archive_wiki.id
}

output "archive_api_token_secret_id" {
  description = "Secret Manager secret name holding the generated ARCHIVE_API_TOKEN — for llm_engine's web-server tier once it's wired to call this service."
  value       = google_secret_manager_secret.archive_api_token.secret_id
}
