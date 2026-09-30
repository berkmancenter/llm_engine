output "instance_name" {
  value = google_compute_instance.bot_media_server.name
}

output "internal_ip" {
  value = google_compute_instance.bot_media_server.network_interface[0].network_ip
}

output "backend_service_id" {
  description = "Pass into webserver-mig's extra_host_backends to front this VM through the shared LB."
  value       = google_compute_backend_service.bot_media_server.id
}
