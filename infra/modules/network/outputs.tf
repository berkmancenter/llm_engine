output "network_id" {
  value = google_compute_network.vpc.id
}

output "network_self_link" {
  value = google_compute_network.vpc.self_link
}

output "network_name" {
  value = google_compute_network.vpc.name
}

output "subnet_id" {
  value = google_compute_subnetwork.primary.id
}

output "subnet_self_link" {
  value = google_compute_subnetwork.primary.self_link
}

output "web_server_tag" {
  description = "Network tag web-server instances must carry for the firewall rules above to apply."
  value       = "web-server"
}

output "chroma_vm_tag" {
  description = "Network tag the Chroma VM must carry for the firewall rules above to apply."
  value       = "chroma-vm"
}

output "iap_ssh_tag" {
  description = "Network tag to add to any instance that should be reachable via IAP SSH tunneling."
  value       = "iap-ssh"
}
