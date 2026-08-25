# Builds a per-release image with THIS release's app container image
# already pulled onto it - eliminates the `docker pull` at instance boot
# (~53s of the ~136s boot-to-healthy time measured during the autoscaling
# load test, the single largest phase - see the published diagnostic
# report and docs/baked-app-image-plan.md in llm_engine-infra).
#
# Layered on top of web-server-base.pkr.hcl's output (Docker already
# installed there), so both savings stack: skip the Docker install AND
# skip the image pull.
#
# One image PER RELEASE, not a rolling family like web-server-base's -
# so a rollback can name an exact prior release's baked image, the same
# way it already names an exact prior web_server_image_tag (see
# docs/cicd.md's rollback section). A shared rolling family would break
# that symmetry: rolling back the app tag without also rolling back to
# the matching baked image defeats the point for that instance (falls
# back to a slow pull - see startup-script.sh.tpl's conditional pull,
# which makes that fallback safe, just not fast).
#
# Built by deploy_prod_gcp.yml on every release, as a best-effort step
# (continue-on-error - a failed bake falls back to today's plain
# pull-at-boot, never blocks the deploy). Not meant to be run by hand
# except to debug the pipeline step itself:
#   packer init .
#   packer build \
#     -var project_id=<project> \
#     -var image_tag=<12-char-sha> \
#     web-server-release.pkr.hcl

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
  description = "GCP project to build the image in (and pull the app image from)."
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "image_tag" {
  type        = string
  description = "Artifact Registry tag of the app image to bake in - matches web_server_image_tag for this release."
}

variable "repository" {
  type    = string
  default = "llm-engine"
}

variable "image" {
  type    = string
  default = "llm-engine"
}

variable "base_image_family" {
  description = "Source image family - web-server-base.pkr.hcl's output, so Docker is already installed."
  type        = string
  default     = "llm-engine-web-base"
}

variable "impersonate_service_account" {
  description = <<-EOT
    Service account for Packer itself to impersonate when calling the
    Compute API. Not the same thing as service_account_email below, which
    is the identity ATTACHED to the temporary build VM; this is the
    identity that creates that VM in the first place.

    Empty (the default) means "use ambient credentials", which is right for
    a human running this locally with their own gcloud ADC.

    CI needs it set. deploy_prod_gcp.yml authenticates as a deploy service
    account that deliberately holds almost nothing directly — Terraform
    gets its power by impersonating an infra-manager account (see that
    environment's providers.tf). Packer was reading the ambient deploy
    identity instead, which has only compute.viewer, so every CI bake
    failed with a 403 on compute.instances.create while the same template
    built fine on a laptop. Pointing this at the same account Terraform
    impersonates closes that gap without widening what the deploy account
    itself can do.
  EOT
  type        = string
  default     = ""
}

locals {
  app_image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.repository}/${var.image}:${var.image_tag}"
}

source "googlecompute" "web_server_release" {
  # See the variable's own description for why CI must set this and a
  # local run should not.
  impersonate_service_account = var.impersonate_service_account

  project_id          = var.project_id
  zone                = var.zone
  source_image_family = var.base_image_family
  image_name          = "llm-engine-web-release-${var.image_tag}"
  image_description   = "llm-engine-web-base + ${local.app_image} pre-pulled, for webserver-mig"
  # Per-release, not a family - see the file header. Nothing reads this by
  # family; webserver-mig's boot_disk_image is set to this exact name.
  ssh_username = "packer"
  machine_type = "e2-small"
  disk_size    = 20

  # Same org policy constraint as web-server-base.pkr.hcl.
  image_storage_locations = ["us-central1"]

  # Same VPC as web-server-base.pkr.hcl - this project has no default
  # network, and webserver-mig's own instances have no external IP.
  network          = "llm-engine-vpc"
  subnetwork       = "llm-engine-vpc-us-central1"
  omit_external_ip = true
  use_internal_ip  = true
  use_iap          = true
  tags             = ["iap-ssh"]

  # A dedicated account, not webserver-mig's own web_server one - this
  # build VM runs third-party code (apt/gcloud install, the docker pull
  # itself), and web_server also holds secretmanager.secretAccessor on
  # both prod secrets. This account has only the Artifact Registry read
  # permission the build needs (see main.tf's web_image_builder_artifact_
  # reader binding) - if the build VM is ever compromised, it can't read
  # prod secrets.
  service_account_email = "llm-engine-web-image-builder@${var.project_id}.iam.gserviceaccount.com"
  scopes                = ["https://www.googleapis.com/auth/cloud-platform"]
}

build {
  sources = ["source.googlecompute.web_server_release"]

  provisioner "shell" {
    inline = [
      "sudo gcloud auth configure-docker ${var.region}-docker.pkg.dev --quiet",
      "sudo docker pull ${local.app_image}"
    ]
  }
}
