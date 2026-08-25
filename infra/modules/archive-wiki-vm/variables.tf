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
  default     = "archive-wiki-vm"
}

variable "iap_ssh_tag" {
  description = "Network tag that allows IAP SSH tunneling to this instance."
  type        = string
  default     = "iap-ssh"
}

variable "machine_type" {
  description = <<-EOT
    Instance shape. archive-wiki-api is a single low-traffic Node process
    (an in-memory lexical search index over a few thousand markdown pages,
    served to occasional MCP/HTTP calls) — no database, no LLM calls of its
    own, nothing CPU- or memory-heavy. e2-micro (the default) is GCP's
    smallest shape and free-tier eligible in us-central1/us-west1/us-east1
    (one instance/month at no cost). Move up to e2-small only if the index
    or request volume outgrows e2-micro's 1GB memory in practice.
  EOT
  type        = string
  default     = "e2-micro"
}

variable "boot_disk_size_gb" {
  description = <<-EOT
    Single persistent disk for everything: OS, Node, the git checkout (wiki
    content + api/'s node_modules and build output), and the one thing this
    app writes at runtime (inbox/conversations/ drafts, untracked until a
    curator commits them — see bkc-archive-wiki/api/README.md). No separate
    attached data disk or snapshot policy, unlike chroma-vm/mongo-vm: the
    wiki content is already durable in git, and a lost draft is a curator
    re-filing a conversation, not a rebuild-from-scratch cost. 15GB is
    comfortable headroom (the whole checkout plus node_modules is well
    under 1GB in practice) without paying for space that will never be used.
  EOT
  type        = number
  default     = 15
}

variable "boot_disk_image" {
  type    = string
  default = "debian-cloud/debian-12"
}

variable "archive_api_port" {
  description = "TCP port archive-wiki-api's HTTP/MCP server listens on (its PORT)."
  type        = number
  default     = 4000
}

variable "archive_api_token_secret_name" {
  description = <<-EOT
    Secret Manager secret name this module writes the generated
    ARCHIVE_API_TOKEN to. llm_engine's web-server tier reads the same
    secret for its own ARCHIVE_API_TOKEN once it's wired to call this
    service — not done by this module (see manual-setup-checklist.md item
    5); this just makes that a drop-in read, same pattern as mongo-vm's
    mongodb_url_secret_name.
  EOT
  type        = string
  default     = "llm-engine-archive-wiki-api-token"
}

variable "deploy_key_secret_name" {
  description = <<-EOT
    Secret Manager secret holding the SSH private key (PEM, ed25519) for a
    read-only GitHub deploy key on berkmancenter/bkc-archive-wiki (private
    repo). Baked into the instance's startup-script metadata at apply time,
    the same way mongo-vm passes its generated DB password — not fetched
    by the VM at runtime, so the instance's service account needs no
    Secret Manager IAM grant for it.

    This secret is NOT created by this module (unlike
    archive_api_token_secret_name above, which this module generates) —
    creating a GitHub deploy key isn't something Terraform's google
    provider can do, and this repo has no github provider configured (see
    providers.tf). One-time manual setup, same shape as the Atlas API key
    pair in providers.tf: generate an ed25519 keypair, add the public half
    as a read-only Deploy Key on the repo, `gcloud secrets create
    <this name> --data-file=<private key path>`. Tracked in
    manual-setup-checklist.md.
  EOT
  type        = string
  default     = "llm-engine-archive-wiki-deploy-key"
}

variable "labels" {
  type    = map(string)
  default = {}
}
