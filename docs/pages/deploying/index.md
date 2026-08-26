# Deploying LLM Engine

The [installing guide](../installing/index.md) covers running LLM Engine locally for
development, as a single process talking to a local MongoDB and ChromaDB. This page
covers running it in production.

## Containerizing

The repo includes a multi-stage `Dockerfile` (`node:22-slim`, `yarn install
--frozen-lockfile`, `tsc` build, runs `node dist/src/index.js`). It exposes two ports —
`PORT` (the HTTP API, default `3000`) and `WEBSOCKET_BASE_PORT` (the websocket service,
default `5555`) — both served by the same process (see `src/websockets/index.ts`), so a
reverse proxy or load balancer in front needs to route both.

## Reference architecture: split infrastructure on GCP

`infra/` contains a set of Terraform modules for running LLM Engine as split
infrastructure on Google Cloud, instead of one box running everything:

- an autoscaled Managed Instance Group for the web server tier, fronted by a global
  HTTPS load balancer (path-based routing to the API and websocket services)
- a dedicated, non-autoscaled VM for ChromaDB (it holds an in-process index — a
  multi-instance, replace-on-deploy model is the wrong shape for it)
- a MongoDB Atlas cluster (via the `mongodbatlas` Terraform provider), with
  auto-scaling compute/storage and VPC peering into the same network
- Cloud Monitoring dashboards, alert policies, and a billing budget alert

These are **modules, not a ready-to-apply deployment** — there's no `environments/`
directory checked in, since a real deployment's project ID, domain, and `tfvars` are
specific to whoever's running it. See [`infra/README.md`](https://github.com/berkmancenter/llm_engine/blob/main/infra/README.md)
for the full module list, design notes (autoscaling signals, org-policy gotchas,
naming/labels), an illustrative cost breakdown, and how to wire the modules into your
own environment.

This is one reference architecture, not the only supported way to run LLM Engine —
GCP was the first target built out because that's what the maintainers needed. If you
build out modules for another provider, a contribution back is very welcome.
