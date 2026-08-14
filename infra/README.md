# Infrastructure modules (Terraform, GCP)

A reference set of Terraform modules for running `llm_engine` on GCP as split
infrastructure: an autoscaled web-server tier, a dedicated ChromaDB VM, and MongoDB,
fronted by a global HTTPS load balancer — instead of one box running Node + Caddy +
MongoDB + ChromaDB together.

MongoDB has two interchangeable module choices — pick one per environment, not both
(see "Atlas vs. mongo-vm" below):

```
infra/
└── modules/
    ├── network/              # VPC, subnet, firewall rules, Cloud NAT
    ├── atlas-cluster/         # MongoDB Atlas cluster/user/peering/backup (mongodbatlas provider)
    ├── mongo-vm/              # standalone single-node MongoDB VM — the no-Atlas fallback
    ├── chroma-vm/             # standalone ChromaDB VM — deliberately not autoscaled
    ├── disk-snapshot-policy/  # shared scheduled-snapshot policy, used by mongo-vm and chroma-vm
    ├── webserver-mig/         # instance template, MIG, autoscaler, HTTPS load balancer
    └── monitoring/            # dashboards, alert policies, billing budget
```

These are **modules, not a deployment** — there's no `environments/` directory here on
purpose. A real deployment (real project ID, domain, `terraform.tfvars`, and the
runbook for the one-time manual GCP/Atlas setup these modules assume) is
environment-specific and belongs in your own private ops repo, not a public one — see
"Bringing your own environment" below.

## Atlas vs. mongo-vm

`atlas-cluster` and `mongo-vm` both end by writing the same thing: a Secret Manager
secret (default name `llm-engine-mongodb-url`) holding a full MongoDB connection
string, which `webserver-mig`'s `mongodb_url_secret_id` variable takes without caring
which module produced it. Instantiate whichever one module you're actually running —
they're not designed to coexist in one environment, and nothing here union-merges
them.

- **`atlas-cluster`** — a managed replica set (default M10, 3 nodes), autoscaling,
  automated backups, VPC peering. The default choice; use it whenever you have (or can
  get) an Atlas Marketplace subscription.
- **`mongo-vm`** — a single standalone `mongod` on one `n2d-standard-2` VM (2 vCPU / 4
  GB RAM), no replica set, no autoscaling. It exists for environments where Atlas
  isn't available yet — no org permission for the Marketplace subscription, for
  example — not as a cheaper everyday alternative to Atlas. Swapping to it later just
  means standing up `mongo-vm`, pointing `webserver-mig` at its `mongodb_url_secret_id`
  output instead of `atlas-cluster`'s, migrating data (`mongodump`/`mongorestore`
  between the two connection strings), and tearing down `atlas-cluster` (or leaving it
  running unused, if you want a fast way back). llm_engine doesn't use multi-document
  transactions or change streams, so a standalone `mongod` is functionally sufficient —
  see `mongo-vm/main.tf` for what that does and doesn't get you: it has backups (see
  below), but no failover — a VM reboot/replacement is real downtime, not a
  replica-set failover.

  Backups are two layered, deliberately independent mechanisms, not one:
  1. A daily cron job on the VM (`startup-script.sh.tpl`) runs `mongodump` at
     `backup_hour_utc` (default 02:00 UTC) straight to a `backups/` directory on the
     same data disk, gzipped, pruned after `backup_retention_days` (default 30 days).
  2. The scheduled disk snapshot described below, timed to run after the dump —
     see "Disk snapshots".

  The dump gives you a logical, `mongorestore`-able backup; the snapshot gives you a
  whole-disk recovery point independent of mongodump ever having run successfully.
  Neither is stored off-disk/off-project (no Cloud Storage upload) — both still live
  in the same GCP project as the VM they back up, so they don't protect against
  project-level loss.

## Disk snapshots

Every stateful data disk in this infra — mongo-vm's and chroma-vm's — shares one
scheduled-snapshot strategy via the `disk-snapshot-policy` module, so it's wired up
identically everywhere instead of hand-copied per module and liable to drift (a
missed attachment, a different retention window, etc.):

| Disk | Snapshot hour (UTC) | Retention | Why that hour |
|---|---|---|---|
| `mongo-vm`'s data disk | `snapshot_hour_utc` (default 04:00) | `snapshot_retention_days` (default 7) | 2 hours after `backup_hour_utc`'s mongodump (default 02:00), so the snapshot only ever runs once that day's dump has reliably finished — see "Atlas vs. mongo-vm" above |
| `chroma-vm`'s data disk | `snapshot_hour_utc` (default 04:00) | `snapshot_retention_days` (default 7) | Same default hour/retention for consistency, but nothing to stagger after — Chroma has no application-level dump step |

Deliberately **not** covered, and not meant to be:
- **Boot disks** (all VMs) and **`webserver-mig`'s instance-template disks** — stateless,
  `auto_delete`d, and rebuilt from the boot image + startup script on every
  replacement; there's no unique state on them worth a recovery point.
- **`atlas-cluster`** — it's not a GCP disk at all, so this module doesn't apply;
  Atlas has its own backup mechanism (`mongodbatlas_cloud_backup_schedule` in
  `atlas-cluster/main.tf`), which is where its snapshot strategy actually lives.

## Design notes worth knowing before you wire these up

- **No Caddy anywhere** — TLS termination and path-based routing both happen at the
  load balancer (`webserver-mig`'s `lb.tf`), not on the instances.
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
# ...atlas_cluster (or mongo_vm — see "Atlas vs. mongo-vm" above, pick one), chroma_vm,
# webserver_mig, monitoring modules, each wired to the previous ones' outputs — see
# each module's variables.tf for its full interface. disk-snapshot-policy isn't
# something you wire up yourself — mongo_vm and chroma_vm each call it internally.
```

Pin `?ref=` to a tag or commit once you've settled on a version, rather than tracking
`main` indefinitely. You'll also need:

- A `backend "gcs"` block and a provider config for `google`/`google-beta`/`random`,
  plus `mongodbatlas` if you're using `atlas-cluster` (see each module's `versions.tf`
  for what's required; `mongo-vm` needs no provider beyond `google`/`random`).
- The one-time manual setup these modules assume already exists: the GCP APIs enabled
  (`compute`, `monitoring`, `billingbudgets`, `secretmanager`, `certificatemanager`),
  and a service account with least-privilege IAM for whatever's applying this (roughly:
  Compute Instance/Network/Security/LoadBalancer Admin, Storage Admin for the state
  bucket, Monitoring Editor, Secret Manager Accessor+Viewer). If you're using
  `atlas-cluster`, add a MongoDB Atlas Marketplace subscription (for unified GCP
  billing) and an Atlas API key pair in Secret Manager for the `mongodbatlas` provider
  to authenticate with — neither is needed for `mongo-vm`.
- One Secret Manager secret your own `environments/` config will need to create and
  reference, holding the app's runtime env vars (JWT secret, LLM provider keys, etc. —
  see `.env.example`). The MongoDB connection-string secret doesn't belong on this
  list — whichever of `atlas-cluster`/`mongo-vm` you use writes that one itself.

## Cost estimate (illustrative, not a quote)

Unit prices sourced 2026-08-13 directly from GCP/MongoDB's own pricing pages —
region `us-central1`, on-demand, no committed-use discount. These are prices for the
underlying resources, not a bill for any particular deployment; your actual sizing
(replica counts, disk sizes, traffic volume) will differ.

| Item | Rate |
|---|---|
| `n2d-standard-2` (web server, Chroma VM, or mongo-vm) | $0.0845/hr (~$62/mo on-demand, ~$43/mo after full-month Sustained Use Discount) |
| `pd-balanced` boot disk | $0.10/GB-mo |
| `pd-ssd` (Chroma's data disk) | $0.17/GB-mo |
| `pd-balanced` data disk (mongo-vm's default) | $0.10/GB-mo |
| Compute Engine snapshot storage (mongo-vm's and Chroma's scheduled snapshots) | ~$0.026/GB-mo, billed on the incremental (changed-block) size, not the full disk each time |
| Cloud NAT | $0.0014/hr per VM + $0.005/hr per IP + $0.045/GiB processed |
| Global external HTTPS LB | $0.025/hr flat for the first 5 forwarding rules + $0.008/GiB each direction |
| MongoDB Atlas M10 | $0.08/hr (~$58/mo) |
| MongoDB Atlas M20 | $0.20/hr (~$146/mo) |
| Secret Manager, Monitoring | negligible at low volume (generous free tiers) |

`mongo-vm` has no Atlas-equivalent line item — its cost is the `n2d-standard-2` VM,
its two disks (boot + data, sized to also hold `backup_retention_days` of mongodump
archives — see `mongo-vm/variables.tf`), and its 7 retained snapshots, all above. That
still undercuts Atlas M10 (~$58/mo) at typical low-volume sizing, before accounting for
what you give up — no managed failover (a VM reboot/replacement is real downtime,
unlike a replica-set failover) and no compute/disk autoscaling.

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
