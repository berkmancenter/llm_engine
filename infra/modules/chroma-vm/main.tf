# Single always-on ChromaDB VM. Deliberately NOT part of any MIG/autoscaler —
# it holds an in-process index and only temporary, rebuildable data, so a
# fixed single instance is the right shape, not horizontal scaling.

resource "google_compute_disk" "chroma_data" {
  project = var.project_id
  name    = "llm-engine-chroma-data"
  zone    = var.zone
  type    = "pd-ssd"
  size    = var.data_disk_size_gb
  labels  = merge(var.labels, { component = "chroma" })
}

resource "google_compute_instance" "chroma" {
  project      = var.project_id
  name         = "llm-engine-chroma-vm"
  zone         = var.zone
  machine_type = var.machine_type
  tags         = [var.network_tag, var.iap_ssh_tag]
  labels       = merge(var.labels, { component = "chroma" })

  boot_disk {
    initialize_params {
      image = var.boot_disk_image
      size  = var.boot_disk_size_gb
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source      = google_compute_disk.chroma_data.self_link
    device_name = "chroma-data"
  }

  network_interface {
    subnetwork = var.subnet_self_link
    # No access_config block: intentionally no external IP. Reachable only
    # from inside the VPC, and administratively only via IAP SSH tunneling.
  }

  metadata = {
    startup-script = templatefile("${path.module}/startup-script.sh.tpl", {
      chroma_image = var.chroma_image
      chroma_port  = var.chroma_port
    })
  }

  # This VM is a stateful singleton with an in-place data disk. Changes that
  # would normally force recreation (machine_type, etc.) instead stop/start
  # it in place so the attached data disk survives. Note: a startup-script
  # metadata change only re-runs on the *next* boot — apply, then reset the
  # instance (`gcloud compute instances reset llm-engine-chroma-vm`) if you need it to
  # take effect immediately rather than at its next natural restart.
  allow_stopping_for_update = true
}
