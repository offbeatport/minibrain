# State

## Failure modes

| Fails | Effect | Mitigation |
|---|---|---|
| main | UI and new jobs pause; inference and running jobs continue | Restart in seconds; leases get a grace period; several mains on Postgres |
| Database | Same as main | Litestream for SQLite; replicated Postgres |
| Artifact store | New jobs and new adapter loads wait | Replicated S3; local caches |
| One gateway | Nothing, with two or more | Stateless copies behind a load balancer |
| One engine | Nothing, with two or more replicas | Health checks; the gateway fails over and rebinds |
| One worker | Jobs wait | More workers |

## Database

SQLAlchemy 2 and Alembic, with no database-specific code. `MINIBRAIN_DATABASE_URL` picks SQLite (the default) or
Postgres. SQLite is enough with one `main`, because only `main` writes and the serving plane does not depend on it.
The schema is the [migrations](../minibrain/registry/migrations/versions/).

Metadata is small and written at a low rate: jobs, versions, keys, engine announcements, batched logs. Postgres does
thousands of writes a second; the bottleneck is GPUs, so a "faster" database buys nothing. Dremio, by contrast, embeds
RocksDB per coordinator and needs ZooKeeper to coordinate them; minibrain keeps one external, replicated database and
nothing else to operate.

## Artifacts

Files are passed by SHA-256 ID, never by path: sources, snapshots, adapters, checkpoints, eval results, logs, batch
results. The store is a local folder or S3-compatible storage; workers and engines keep local caches. Base model
weights are pinned by repository and revision and follow the store: with a bucket, each file is an object under its
SHA-256 and every machine that runs the model keeps a working copy, fetched straight from the bucket on links main
signs. Other artifacts flow through `main`.

## Several mains

With Postgres, several mains share the database behind a load balancer. One holds a session-level Postgres advisory
lock and runs the leader-only loops; the others stand by and serve the UI, `/api` and their gateway.

| Loop | Runs on |
|---|---|
| Job lease expiry | Leader |
| Catalogue sync schedule | Leader |
| Request log purge, forgetting stale machines | Leader |
| Gateway config rebuild | Every main (each serves its own gateways) |
| Idle engine unload | Every main (its own local engines) |

- Failover: if the leader dies, its session ends and Postgres releases the lock; the next main to ask takes over.
  TCP keepalives bound how long a partitioned leader's session lingers. Leader-only work is idempotent, so a short
  overlap is harmless.
- The Compute page shows whether this main runs the loops ("Runs here", "Runs here (leader)", "Standby").
- A single SQLite box stays a single, non-HA main.
- No ZooKeeper or etcd of our own: consensus is delegated to Postgres HA (Patroni, a managed Postgres) and, on
  Kubernetes, to Kubernetes.
