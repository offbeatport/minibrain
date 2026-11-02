# minibrain architecture

Production runs on GPU racks, rented or on-prem; a laptop install is onboarding. One install is one supervised process
tree started by one command. `main` is the control plane: it owns the database, the jobs, the policies and the
configuration. Gateways and engines are the serving plane: they answer inference requests from a cached configuration,
so they keep serving while `main` restarts. Workers are the batch plane: they run data preparation, training and eval.
Workers and engines talk to `main` only over HTTP, so a GPU box elsewhere is the same program with a URL, a token and a
pool name.

| Doc | Covers |
|---|---|
| [security.md](security.md) | Policies, trust zones, ports |
| [state.md](state.md) | Failure modes, database, artifacts, several mains |
| [serving.md](serving.md) | Planes, request path, engines, routing, compute pools |
| [models.md](models.md) | Catalogue, Add from Hugging Face, sources, import formats |
| [jobs.md](jobs.md) | Job contract, lifecycle, retries |

Endpoints: [`web/openapi.json`](../web/openapi.json). Tables: [migrations](../minibrain/registry/migrations/versions/).

## Roles

| Role | Plane | Local (`minibrain serve`) | Deployed | Scales by | Database |
|---|---|---|---|---|---|
| main | Control | The parent process | Its own service; two or more with Postgres | Copies behind a load balancer | The only reader and writer |
| gateway | Serving | Inside main | `minibrain gateway` | Copies behind a load balancer | Cached config snapshot |
| engine | Serving | A supervised child per model | `minibrain engine --pool …` on each GPU box | Copies per model, across boxes | HTTP to main |
| worker | Batch | A supervised child | `minibrain worker --pool …` on each GPU box | More boxes per pool | HTTP to main |
| training / eval | Batch | A child of the worker | Same, on the worker's box | One per job | None |

## Deployment shapes

Same roles, same code; only where they run changes. The three pictures share one layout: callers on the left, the
inference path across the top, main and its state in the middle, GPU pools on the right. Colour is the plane: blue
control, green serving, amber batch. [`diagrams/topology.html`](diagrams/topology.html) is the interactive version,
with failure drills.

### One machine: onboarding and evaluation

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/one-machine-dark.svg">
  <img alt="One machine: minibrain serve runs main, the gateway, a worker and engines with SQLite and a folder" src="diagrams/one-machine.svg">
</picture>

### Local main, remote GPUs

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/local-main-remote-gpus-dark.svg">
  <img alt="Local main, remote GPUs: main and its gateway on a laptop or small VM, workers and engines on a GPU box" src="diagrams/local-main-remote-gpus.svg">
</picture>

### Production: separate services

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/production-dark.svg">
  <img alt="Production: load balancers, gateways, two mains, GPU pools, Postgres and S3, in trust zones" src="diagrams/production.svg">
</picture>

| | One machine | Local main, remote GPUs | Production |
|---|---|---|---|
| main | `minibrain serve` | `minibrain serve` on a laptop or small VM | Two or more behind a load balancer |
| Gateways | Inside main | Inside main | `minibrain gateway` ×N behind a load balancer |
| Workers and engines | Local children, pool "This machine" | On GPU boxes, one pool per rack | GPU racks, several pools |
| Database | SQLite | SQLite | Postgres, highly available |
| Artifacts | Folder | Folder | S3-compatible |

| Stage | Who starts workers and engines |
|---|---|
| v1 | People or their tooling: `minibrain worker` and `minibrain engine` on each box (systemd, Compose, Slurm) |
| v2 | A Kubernetes launcher: main creates Jobs for training and Deployments for engine replicas, autoscaled |
| Later | A cloud VM launcher for rented GPUs |

## Decisions

| Decision | Why | Cost |
|---|---|---|
| One control plane: main and one database | One source of truth, simple operations | Changes need main; HA needs Postgres and several mains |
| Workers and engines pull from main over HTTP | Outbound-only GPU boxes, no database credentials outside main, one SQLite writer | Artifacts flow through main until workers read S3 directly |
| HTTP, not gRPC | The job channel carries a few requests a second and inference is GPU-bound; HTTP streaming serves both | Larger messages than protobuf |
| Own jobs table | Leases and fencing in one table, no broker, works on SQLite. Procrastinate is Postgres-only, Huey keeps a second record without leases, Celery / RQ / Dramatiq need a broker, Temporal / Hatchet / Prefect are separate servers | We own the bugs; DBOS Transact is the candidate for multi-step pipelines |
| Jobs found by polling | No broker | Up to one poll interval of latency; Postgres LISTEN/NOTIFY later |
| No coordination service | The database coordinates jobs; a Postgres advisory lock picks the leader | HA depends on Postgres HA (Patroni or managed) |
| Config up to ~1 s stale | No database read per inference request | A revoked key works for up to a second |
| One base model per engine process | Simple lifecycle, many adapters per model | More processes; replicas scale out, autoscaled on Kubernetes |
| One package for every role | One install, one version | A large install; split extras later |
| Python gateway | Same code and models as main | More replicas than a native proxy; Go or Rust only if ever needed |
| No Compose or Kubernetes requirement | Docker on macOS has no GPU; `uvx minibrain serve` works on a laptop and air-gapped | Workers and engines started by hand in v1; a Kubernetes launcher in v2 |
