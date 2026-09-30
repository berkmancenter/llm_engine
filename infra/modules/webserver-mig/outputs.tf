output "instance_group" {
  value = google_compute_region_instance_group_manager.web_server.instance_group
}

output "mig_name" {
  value = google_compute_region_instance_group_manager.web_server.name
}

output "web_server_service_account_email" {
  value = google_service_account.web_server.email
}

output "web_image_builder_service_account_email" {
  description = "Identity web-server-release.pkr.hcl's build VM runs as - image-pull access only, not the app's own secret access."
  value       = google_service_account.web_image_builder.email
}

output "load_balancer_ip" {
  description = "Static IP for the HTTPS load balancer — point the domain's DNS A record here (see manual-setup-checklist.md item 5)."
  value       = google_compute_global_address.web_server.address
}

output "managed_ssl_certificate_name" {
  description = <<-EOT
    google_compute_managed_ssl_certificate has no status attribute exposed
    to Terraform (confirmed against the actual provider schema) — check
    ACTIVE-ness via `gcloud compute ssl-certificates describe
    <this name> --format="value(managed.status)"` instead, after DNS is
    repointed and before cutting over from the old box.
  EOT
  value       = google_compute_managed_ssl_certificate.web_server.name
}

output "frontend_backend_service_name" {
  description = "Null when var.frontend_origin is unset (\"\") — no frontend backend/NEG exists in that case."
  value       = one(google_compute_backend_service.frontend[*].name)
}
