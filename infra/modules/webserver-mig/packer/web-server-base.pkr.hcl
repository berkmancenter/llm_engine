# Builds a custom Debian 12 image with Docker pre-installed, so
# startup-script.sh.tpl skips its `apt-get install docker.io` step on every
# instance boot - measured at ~35s/instance (~25% of the 136s boot-to-healthy
# time observed during the autoscaling load test, see k6/README.md and the
# published diagnostic report). Everything else about the instance stays
# identical: startup-script.sh.tpl's `if ! command -v docker` check already
# no-ops when Docker is present, so this is a drop-in replacement for
# `boot_disk_image` - no changes needed to the module or the startup script.
#
# Build (from this directory):
#   packer init .
#   packer build -var project_id=<project> web-server-base.pkr.hcl
#
# Then point webserver-mig's `boot_disk_image` variable at the family this
# produces - see variables.tf's description - which always resolves to the
# most recently built image:
#   "projects/<project_id>/global/images/family/llm-engine-web-base"
#
# Rebuild periodically to pick up Debian security patches (the source image
# itself isn't pinned to a specific point-in-time build). A stale custom
# image doesn't break anything - apt just has more catching up to do at
# boot, same as today, just from a smaller base.

packer {
  required_plugins {
    googlecompute = {
      version = ">= 1.1.1"
      source  = "github.com/hashicorp/googlecompute"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP project to build the image in (and publish it to)."
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "image_family" {
  description = <<-EOT
    Image family name. webserver-mig's boot_disk_image should reference
    "projects/<project_id>/global/images/family/<this>" rather than a
    specific image name, so Terraform always picks up the latest build
    without a variable change on every rebuild.
  EOT
  type        = string
  default     = "llm-engine-web-base"
}

variable "impersonate_service_account" {
  description = <<-EOT
    Service account for Packer itself to impersonate when calling the
    Compute API — the identity that CREATES the temporary build VM, not one
    attached to it.

    Empty (the default) means "use ambient credentials", which is right for
    a human running this locally with their own gcloud ADC. This template is
    built by hand today, so that default is the normal path.

    Set it if this is ever automated. A CI deploy account typically holds
    almost nothing directly and gets its power by impersonating an
    infra-manager account; Packer reading the ambient identity instead is
    what made every CI run of the sibling release template 403 on
    compute.instances.create while building fine on a laptop. Kept here so
    automating this one doesn't rediscover that the hard way — see
    web-server-release.pkr.hcl.
  EOT
  type        = string
  default     = ""
}

source "googlecompute" "web_server_base" {
  # See the variable's description: needed only if this is automated.
  impersonate_service_account = var.impersonate_service_account

  project_id              = var.project_id
  zone                    = var.zone
  source_image_family     = "debian-12"
  source_image_project_id = ["debian-cloud"]
  image_name              = "llm-engine-web-base-${formatdate("YYYYMMDD-hhmmss", timestamp())}"
  image_family            = var.image_family
  image_description       = "debian-12 + docker.io pre-installed, for llm-engine's webserver-mig"
  # This org's constraints/gcp.resourceLocations policy restricts storage to
  # us-central1/us-east4 (see llm_engine-infra's docs/applying-changes.md) -
  # Packer's default (unset -> multi-region "us") violates it.
  image_storage_locations = ["us-central1"]
  ssh_username            = "packer"
  # Only needs to run apt-get for a few minutes, not serve traffic -
  # smallest practical machine type keeps build cost negligible.
  machine_type = "e2-small"
  disk_size    = 20

  # This project's network has no "default" VPC (network module creates
  # llm-engine-vpc instead) and webserver-mig's own instances have no
  # external IP - mirror both here, plus the iap-ssh tag the network
  # module's firewall rule already targets, so Packer reaches the build
  # instance the same way the real MIG instances are reached.
  network          = "llm-engine-vpc"
  subnetwork       = "llm-engine-vpc-us-central1"
  omit_external_ip = true
  use_internal_ip  = true
  use_iap          = true
  tags             = ["iap-ssh"]
}

build {
  sources = ["source.googlecompute.web_server_base"]

  # Mirrors exactly what startup-script.sh.tpl's Docker block does today -
  # baking the same install here, not a different one, keeps the two in
  # sync by construction rather than by convention.
  provisioner "shell" {
    inline = [
      "sudo apt-get update",
      "sudo apt-get install -y docker.io",
      "sudo systemctl enable docker"
    ]
  }
}
