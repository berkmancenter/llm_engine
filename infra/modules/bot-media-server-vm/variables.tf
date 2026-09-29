variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  description = "Zone within region for the single instance."
  type        = string
  default     = "us-central1-a"
}

variable "network_self_link" {
  description = "Self link of the VPC network (from the network module) — required alongside subnet_self_link by the zonal NEG below."
  type        = string
}

variable "subnet_self_link" {
  description = "Self link of the subnet (from the network module) to attach the instance to."
  type        = string
}

variable "network_tag" {
  description = "Network tag applied so the network module's firewall rules match this instance."
  type        = string
  default     = "bot-media-server-vm"
}

variable "iap_ssh_tag" {
  description = "Network tag that allows IAP SSH tunneling to this instance."
  type        = string
  default     = "iap-ssh"
}

variable "machine_type" {
  description = <<-EOT
    Instance shape. Unlike archive-wiki-api, this process loads an 82M-param
    ONNX TTS model (Kokoro) into memory and runs CPU inference on it per
    text chunk — e2-micro's 1GB is too tight for that. e2-medium (the
    default) gives 4GB/2 vCPU as a starting point; revisit once real
    concurrent-conversation counts are known, the same way webserver-mig's
    own machine_type note flags its shape as provisional.
  EOT
  type        = string
  default     = "e2-medium"
}

variable "boot_disk_size_gb" {
  description = <<-EOT
    Single persistent disk for everything: OS, Node, yarn's node_modules for
    the whole llm_engine monorepo (not just bot-media-server/ — there's no
    per-package install here), and the synced Kokoro model files. 20GB
    matches webserver-mig's own default headroom.
  EOT
  type        = number
  default     = 20
}

variable "boot_disk_image" {
  type    = string
  default = "debian-cloud/debian-12"
}

variable "bot_media_server_port" {
  description = "TCP port bot-media-server's HTTP+socket.io server listens on (its PORT)."
  type        = number
  default     = 3100
}

variable "web_server_image_tag" {
  description = <<-EOT
    Git ref (commit SHA in practice) of berkmancenter/llm_engine to check
    out. Deliberately the SAME value webserver-mig's own
    web_server_image_tag already tracks — kept current by the existing
    nightly deploy job — not the Terraform module source pin
    (locals.llm_engine_ref), which is bumped rarely and sometimes points at
    a side branch on purpose. Picking up a new value here does not restart
    this instance by itself: apply -replace on this specific resource,
    timed for a moment with no active calls (see this module's main.tf).
  EOT
  type        = string
  default     = "main"
}

variable "app_env_secret_id" {
  description = <<-EOT
    Secret Manager secret name holding this process's dotenv-formatted
    runtime secrets (LLM_ENGINE_USERNAME/PASSWORD — see
    bot-media-server/.env.example for the full set). Same pattern as
    webserver-mig's app_env_secret_id: fetched at boot via `gcloud secrets
    versions access`, not baked into instance metadata, and not owned by
    Terraform — create/update it yourself:
      gcloud secrets create bot-media-server-app-env --data-file=prod.env
      gcloud secrets versions add bot-media-server-app-env --data-file=prod.env
  EOT
  type        = string
  default     = "bot-media-server-app-env"
}

variable "model_bucket_name" {
  description = <<-EOT
    GCS bucket holding the staged Kokoro TTS model files, synced onto the
    instance at boot into bot-media-server/models/ (see that package's
    README — no automatic download in production). No default: this is a
    real, project-specific bucket created by hand (see
    manual-setup-checklist.md), not something a shared reference module
    should assume the name of.
  EOT
  type        = string
}

variable "internal_llm_engine_url" {
  description = <<-EOT
    llm_engine HTTP base URL this process logs into and drives conversations
    through — the new internal backend service on webserver-mig
    (INTERNAL load balancing scheme), not the public domain. Not a secret;
    templated straight into the startup script, same as webserver-mig's own
    chroma_url.
  EOT
  type        = string
}

variable "internal_llm_engine_ws_url" {
  description = "llm_engine websocket base URL — same internal backend service as internal_llm_engine_url, different port."
  type        = string
}

variable "health_check_path" {
  description = "HTTP path the LB health check probes — bot-media-server's own liveness route (app.ts)."
  type        = string
  default     = "/health"
}

variable "labels" {
  type    = map(string)
  default = {}
}
