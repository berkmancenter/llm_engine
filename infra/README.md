# Infrastructure modules (Terraform, GCP)

A reference set of Terraform modules for running `llm_engine` on GCP as split
infrastructure: an autoscaled web-server tier, a dedicated ChromaDB VM, and a MongoDB
Atlas cluster, fronted by a global HTTPS load balancer — instead of one box running
Node + Caddy + MongoDB + ChromaDB together.

```
infra/
└── modules/
    ├── network/          # VPC, subnet, firewall rules, Cloud NAT
    ├── atlas-cluster/     # MongoDB Atlas cluster/user/peering/backup (mongodbatlas provider)
    ├── chroma-vm/         # standalone ChromaDB VM — deliberately not autoscaled
    ├── webserver-mig/     # instance template, MIG, autoscaler, HTTPS load balancer
    └── monitoring/        # dashboards, alert policies, billing budget
```

These are **modules, not a deployment** — there's no `environments/` directory here on
purpose. A real deployment (real project ID, domain, `terraform.tfvars`, and the
runbook for the one-time manual GCP/Atlas setup these modules assume) is
environment-specific and belongs in your own private ops repo, not a public one — see
"Bringing your own environment" below.

## Design notes worth knowing before you wire these up

- **No Caddy anywhere** — TLS termination and path-based routing both happen at the
  load balancer (`webserver-mig`'s `lb.tf`), not on the instances.
- **`webserver-mig`'s `frontend_origin`** (optional, default `""`) lets the LB proxy
  its fallback route (anything not `/v1/*` or `/socket.io/*`) to an external frontend
  origin — e.g. a Vercel deployment — so the frontend and this backend share one
  domain. Implemented as a global "internet NEG" backend with the outbound `Host`
  header rewritten to `frontend_origin`, since host-based routers like Vercel need
  that to pick the right deployment. Same three-way split (`/v1/*` -> api,
  `/socket.io/*` -> websocket, fallback -> frontend) as the old single-box
  Caddyfile's `handle` blocks, just moved to the LB.
- **Chroma is a fixed singleton, not autoscaled** — it holds an in-process index and
  only temporary/rebuildable data, so a MIG's multi-instance, replace-on-deploy model
  is the wrong shape for it. It gets its own persistent disk instead.
- **`webserver-mig`'s autoscaler** targets a custom Cloud Monitoring metric
  (`custom.googleapis.com/app/concurrent_connections`) with CPU utilization as a
  fallback signal — GCP's autoscaler scales to whichever signal demands more, not a
  blend. Your app needs to actually publish that custom metric for the primary signal
  to do anything; until it does, this silently falls back to CPU-only.
- **Naming/labels**: every resource is named `llm-engine-*` and labeled
  (`app=llm-engine`, `component=<web-server|chroma|atlas>`) everywhere the GCP resource
  type actually supports a `labels` argument — useful for cost/inventory filtering if
  this shares a project with other things. Several resource types used here (subnets,
  firewall rules, health checks, backend services, managed SSL certs) don't support
  labels at all — naming is the only identification mechanism GCP offers for those.
- **Org policy gotcha**: if your org enforces `constraints/gcp.resourceLocations`,
  Secret Manager's default automatic/global replication will violate it — use
  `replication { user_managed { replicas { location = var.region } } }` (see
  `atlas-cluster/main.tf`) instead of `replication { auto {} }`, and the same
  `--replication-policy=user-managed --locations=<region>` flag on any
  `gcloud secrets create` you run by hand.
- **GCP Infrastructure Manager doesn't work under that same org policy** — its backing
  storage defaults to the `US` multi-region regardless of the deployment's `--location`,
  with no documented override. Plain `terraform` CLI + a self-managed
  `backend "gcs"` pinned to your region sidesteps it, at the cost of running `terraform`
  yourself instead of having a managed service do it.

## Bringing your own environment

Each module takes GCP-native variables (no required defaults reference any specific
project/org). A minimal `environments/prod/main.tf` wiring them together looks like:

```hcl
module "network" {
  source     = "git::https://github.com/berkmancenter/llm_engine.git//infra/modules/network?ref=main"
  project_id = var.project_id
  region     = var.region
}
# ...atlas_cluster, chroma_vm, webserver_mig, monitoring modules, each wired to the
# previous ones' outputs — see each module's variables.tf for its full interface.
```

Pin `?ref=` to a tag or commit once you've settled on a version, rather than tracking
`main` indefinitely. You'll also need:

- A `backend "gcs"` block and a provider config for `google`/`google-beta`/
  `mongodbatlas`/`random` (see each module's `versions.tf` for what's required).
- The one-time manual setup these modules assume already exists: a MongoDB Atlas
  Marketplace subscription (for unified GCP billing), the GCP APIs enabled
  (`compute`, `monitoring`, `billingbudgets`, `secretmanager`, `certificatemanager`),
  a service account with least-privilege IAM for whatever's applying this (roughly:
  Compute Instance/Network/Security/LoadBalancer Admin, Storage Admin for the state
  bucket, Monitoring Editor, Secret Manager Accessor+Viewer), and an Atlas API key
  pair in Secret Manager for the `mongodbatlas` provider to authenticate with.
- Two Secret Manager secrets your own `environments/` config will need to create and
  reference: one holding the app's runtime env vars (JWT secret, LLM provider keys,
  etc. — see `.env.example`), and one the `atlas-cluster` module itself writes the
  Atlas connection string into.

## Cost estimate (illustrative, not a quote)

Unit prices sourced 2026-08-13 directly from GCP/MongoDB's own pricing pages —
region `us-central1`, on-demand, no committed-use discount. These are prices for the
underlying resources, not a bill for any particular deployment; your actual sizing
(replica counts, disk sizes, traffic volume) will differ.

| Item | Rate |
|---|---|
| `n2d-standard-2` (web server or Chroma VM) | $0.0845/hr (~$62/mo on-demand, ~$43/mo after full-month Sustained Use Discount) |
| `pd-balanced` boot disk | $0.10/GB-mo |
| `pd-ssd` (Chroma's data disk) | $0.17/GB-mo |
| Cloud NAT | $0.0014/hr per VM + $0.005/hr per IP + $0.045/GiB processed |
| Global external HTTPS LB | $0.025/hr flat for the first 5 forwarding rules + $0.008/GiB each direction |
| MongoDB Atlas M10 | $0.08/hr (~$58/mo) |
| MongoDB Atlas M20 | $0.20/hr (~$146/mo) |
| Secret Manager, Monitoring | negligible at low volume (generous free tiers) |

**What's automatic vs. a decision:**

- **Sustained Use Discounts (SUD)** apply automatically, no setup — up to 30% off
  vCPU/memory for any N2D usage running a large fraction of the billing month. Doesn't
  apply to disks, Cloud NAT, the load balancer, Secret Manager, or Atlas (a Marketplace
  SaaS charge, entirely outside GCP's SUD/CUD mechanism).
- **Committed Use Discounts (CUD)** are a deliberate choice, not automatic, and replace
  (don't stack with) SUD on whichever instances you commit — up to ~55% for
  general-purpose machine types at a 3-year term, in exchange for paying for that
  capacity regardless of actual usage. Worth deferring until real traffic has validated
  your sizing is stable.

**Sources**: [Compute Engine pricing](https://cloud.google.com/compute/all-pricing),
[Persistent Disk pricing](https://cloud.google.com/compute/disks-image-pricing),
[Cloud NAT pricing](https://cloud.google.com/nat/pricing),
[VPC/Load Balancing pricing](https://cloud.google.com/vpc/network-pricing),
[MongoDB Atlas pricing](https://www.mongodb.com/pricing),
[Secret Manager pricing](https://cloud.google.com/secret-manager/pricing),
[Sustained use discounts](https://docs.cloud.google.com/compute/docs/sustained-use-discounts),
[Committed use discounts overview](https://docs.cloud.google.com/compute/docs/instances/committed-use-discounts-overview).
Re-check these before budgeting against them — none of the figures above are pulled
live, so this goes stale the moment either vendor reprices anything.
