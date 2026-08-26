# Single always-on ChromaDB VM. Deliberately NOT part of any MIG/autoscaler —
# it holds an in-process index and only temporary, rebuildable data, so a
# fixed single instance is the right shape, not horizontal scaling.
#
# The data disk still gets the same scheduled-snapshot policy every other
# stateful disk in this infra uses (see disk-snapshot-policy module):
# "rebuildable" here means re-running embeddings for every document
# through an LLM provider, which costs real time and money, so a snapshot
# is a much cheaper first line of recovery than a full rebuild even though
# it's not the disk of record the way mongo-vm's is.

resource "google_compute_disk" "chroma_data" {
  project = var.project_id
  name    = "llm-engine-chroma-data"
  zone    = var.zone
  type    = "pd-ssd"
  size    = var.data_disk_size_gb
  labels  = merge(var.labels, { component = "chroma" })

  # Rebuildable in principle (see the module comment above), but a rebuild
  # costs real time and LLM-provider spend — protect it from an accidental
  # `terraform destroy`/replace the same way mongo-vm's disk of record is.
  lifecycle {
    prevent_destroy = true
  }
}

# Dedicated service account for the Ops Agent (CPU/memory/disk metrics —
# see monitoring module). Without this, the instance runs with NO service
# account at all — Terraform's google_compute_instance, unlike `gcloud
# compute instances create`, does not implicitly attach the project's
# default Compute Engine service account when the service_account block is
# omitted (confirmed live: `gcloud compute instances describe ...
# --format='yaml(serviceAccounts)'` returns null) — which is why the
# existing chroma_memory_pressure alert (monitoring module) has never
# actually been able to fire: the Ops Agent was never installed, and even
# installed, had nothing to authenticate with. Mirrors webserver-mig's own
# dedicated-SA pattern.
resource "google_service_account" "chroma_vm" {
  project      = var.project_id
  account_id   = "llm-engine-chroma-vm"
  display_name = "llm_engine chroma-vm (Ops Agent)"
}

resource "google_project_iam_member" "chroma_vm_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.chroma_vm.email}"
}

resource "google_project_iam_member" "chroma_vm_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.chroma_vm.email}"
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

  service_account {
    email  = google_service_account.chroma_vm.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
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

module "data_disk_snapshot" {
  source = "../disk-snapshot-policy"

  project_id        = var.project_id
  region            = var.region
  zone              = var.zone
  disk_name         = google_compute_disk.chroma_data.name
  policy_name       = "llm-engine-chroma-data-snapshot"
  snapshot_hour_utc = var.snapshot_hour_utc
  retention_days    = var.snapshot_retention_days
  labels            = merge(var.labels, { component = "chroma" })
}
