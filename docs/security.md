# Security

## Policies

Settings → Security. Values from `minibrain.yaml` (`policy:`) or `MINIBRAIN_POLICY_<NAME>` are locked in the UI and
show "Set by config file" or "Set by environment"; the rest are editable, and every change is written to the audit
log with who, before and after.

| Policy | Values | Enforced at |
|---|---|---|
| Network | Open, Allowlist (hosts), Offline (`MINIBRAIN_OFFLINE` forces it) | Downloads, retries, S3 imports, catalogue sync, Add from Hugging Face, the online check |
| Model sources | Approved publishers (default), any, imports only | Download, retry, Add from Hugging Face (shown only with any) |
| Licences | Only selected licences (default; a list of reviewed commercial licences) or any licence, including unreviewed ones | Download, retry, Add from Hugging Face |
| Safetensors only | Always on | Download file filter; pickle weights are never loaded |
| Request logs | On or off, retention in days | Gateway config; hourly purge on the leader |
| API keys | Expiry in days for new keys | Gateway rejects expired keys with 401, and models the key does not cover with 403 |
| Audit log retention | Days, 0 keeps every event (default) | Hourly prune on the leader, cut at a chain anchor (below) |
| SIEM export | Off (default), TLS, TCP or UDP; host, port (0 is 6514 for TLS, 514 otherwise), CA bundle path | Syslog forwarder on the leader (below) |

## Trust zones and ports

| Zone | Holds | Accepts connections from | Ports |
|---|---|---|---|
| Corporate network | Apps, browsers | | |
| Edge | Load balancers | The corporate network | 443 |
| Internal network | Gateways, mains, Postgres, S3 | The edge; GPU pools reach main only | gateway 8100, main 8000, Postgres 5432, S3 443 |
| GPU network | Workers, engines | Engines: gateways only. Workers: nothing | Outbound HTTPS to main 8000 |

- GPU boxes need no internet access: engines and workers pull weights, adapters and snapshots from `main`.
- Workers and engines hold a shared token (`MINIBRAIN_WORKER_TOKEN`, `MINIBRAIN_GATEWAY_TOKEN`), never database
  credentials.
- Identity headers from a reverse proxy are trusted only when the request comes from a configured proxy address.
- Deleting a model writes an audit event with who, what and its size.
- No outbound telemetry. With the Offline network policy nothing leaves the install, except audit events to the SIEM
  you configure and artifact storage you point at a bucket; Settings → This install lists both.
- Content hashes and signatures use SHA-256 through OpenSSL or `cryptography`; never MD5 or SHA-1.

## Audit log integrity

Every audit event is append-only and hash-chained. Writers insert events as before, with no chain fields; the leader
seals them about once a second. Sealing locks the one-row `audit_chain` head (an `UPDATE` of that row, which waits on
Postgres and takes SQLite's write lock), takes the unsealed events in id order and gives each the next sequence number
(`seq`), the previous event's hash (`prev_hash`) and its own `hash`, then moves the head. On Postgres an id can commit
after a higher one; it is simply sealed later, with a higher `seq`, so the chain follows commit order and nothing is
skipped. A unique index on `seq` backs the lock. Events recorded before the chain existed are chained on the first seal,
in id order.

`hash` is the lowercase hex SHA-256 of the event's canonical form: this JSON object as ASCII bytes, with keys sorted
at every level, no whitespace (`,` and `:` as separators) and every non-ASCII character escaped as `\uXXXX`
(Python's `json.dumps(fields, sort_keys=True, separators=(",", ":"))`):

| Key | Value |
|---|---|
| `seq` | Sequence number, from 1 |
| `prev_hash` | The previous event's `hash`; 64 zeros for seq 1 |
| `at` | UTC time with six fractional digits and `Z`, as `2026-11-03T12:34:56.123456Z` |
| `actor`, `ip`, `action`, `target` | As recorded; `ip` is `null` when not recorded |
| `detail` | The detail object with secret-named string values replaced by `[redacted]`, exactly as the API and exports show it |

The row id is not hashed, so the chain survives a copy into another database. Hashing the redacted detail means every
export and every SIEM message can be checked on its own, without the server.

Verification walks the events in `seq` order and reports the first break: an event whose fields no longer match its
hash, one that does not link to the event before it, a missing `seq`, events past the head that minibrain did not
seal, or a newest event that does not match the head. It runs from Settings → Audit log (Integrity, "Verify again"),
`GET /api/audit/chain`, and `minibrain audit verify` (exit code 1 on a break; `--file <export.jsonl>` checks an
unfiltered JSONL export instead of the database; `--json` prints the report).

Retention keeps the chain checkable. The hourly prune deletes sealed events up to the newest one whose `seq` and all
before it are older than the retention period (never an unsealed event, and with SIEM export on, never one the SIEM
has not received), then writes an `audit.prune` event with `cut_seq` and `cut_hash`: the last deleted event's `seq`
and `hash`. That event is chained like any other. Verification starts at the oldest remaining event and needs either
`seq` 1 linking to 64 zeros, or a prune whose `cut_seq` is the event just before it and whose `cut_hash` is its
`prev_hash`.

What the chain shows: any edit, deletion or insertion inside the retained log, and deletions at either end. What it
cannot show on its own: someone with write access to the database rewriting every hash from the point they changed
onwards, since the chain uses no key. The SIEM's copy is the witness for that: its hashes stop matching the
database's from the rewritten event on.

## SIEM export

Off by default. With a protocol and host set, the leader sends every sealed event, in `seq` order, to that one
address and nowhere else; the network policy does not apply to it, as it does not to artifact storage.

- RFC 5424 syslog: facility 13 (log audit), severity 5 (notice), so PRI is `<109>`; the event time as the timestamp;
  this host's name; app name `minibrain`; the action as MSGID; `[origin software="minibrain" swVersion="…"]` as
  structured data; and the event as JSON, ASCII only, as the message: the canonical fields plus `id` and `hash`.
- TLS (RFC 5425) and TCP use octet-counting framing (`<length> <message>`, RFC 6587). TLS goes through Python's `ssl`
  module (OpenSSL), TLS 1.2 or later, and checks the certificate and host name against the CA bundle, or the system's
  CAs when none is set. UDP (RFC 5426) sends one message per datagram and cannot tell whether it arrived.
- The head row keeps a cursor: the last `seq` sent. Each batch of up to 500 events goes over a fresh connection:
  minibrain writes it, closes its side (a TLS close_notify first) and waits up to 2 seconds for the SIEM to close
  too, which a receiver does once it has read everything, then moves the cursor. A restart or a new leader resumes
  at the next event. A connection that fails mid-batch sends the whole batch again, so the SIEM may see an event
  twice (same `seq` and `hash`, so it can drop the copy). UDP has none of these checks.
- While the SIEM is unreachable minibrain retries every 15 seconds, events queue in the database, and Settings →
  Audit log shows the error and how many events wait. Turning export on for the first time sends the whole retained
  log, oldest first.

## Bills of materials

### Software (SBOM)

Every CI run uploads a `minibrain-sbom` artifact beside the wheel with two CycloneDX JSON files. `mise run sbom`
writes the same two into `sbom/`.

| File | Format | Made by | Covers |
|---|---|---|---|
| `minibrain-python.cdx.json` | CycloneDX 1.5 | `uv export --format cyclonedx1.5` from `uv.lock` | The wheel's dependencies with every extra (`postgres`, `mlx`, `llamacpp`), no dev group: version, purl, the SHA-256 of every sdist and wheel, platform markers and the dependency graph |
| `minibrain-web.cdx.json` | CycloneDX 1.6 | syft from `web/pnpm-lock.yaml` | Every package in the lockfile, by name, version and purl. syft does not tell dev dependencies apart in pnpm lockfiles, so the build tools (Vite, TypeScript, Biome) are listed too; the built UI ships only what `dependencies` pulls in |

- Both read only the lockfile: no install, no registry lookups. `uv export --frozen` never resolves; uv marks the
  CycloneDX export experimental (`--preview-features sbom-export`), so the format can change with uv, which CI pins.
- syft's network features (remote licence lookups for npm, Python, Go and Maven) are off by default and stay off.
  Its update check is on by default; `SYFT_CHECK_FOR_APP_UPDATE=false` turns it off, in CI and in `mise run sbom`.
- CI downloads syft by release version and checks the archive's SHA-256 (`SYFT_VERSION` and `SYFT_SHA256` in
  `.github/workflows/ci.yml`).

### Docker image

CI does not build the image (the CUDA one is about 7 GB). Its Python packages are the `--no-dev --extra postgres`
subset of `minibrain-python.cdx.json`, except torch, which comes from the PyTorch index as the CUDA or CPU build. For
the whole image, operating system packages included, run syft against the built image:

```sh
SYFT_CHECK_FOR_APP_UPDATE=false SYFT_FILE_METADATA_DIGESTS=sha256 \
  syft scan docker:minibrain:cuda --source-name minibrain --source-version "$(git rev-parse HEAD)" \
  -o cyclonedx-json@1.6=minibrain-cuda.cdx.json
```

- `docker:` reads the image from the local Docker daemon; nothing is pulled. To scan elsewhere, save it
  (`docker save minibrain:cuda -o minibrain-cuda.tar`) and run `syft scan docker-archive:minibrain-cuda.tar`.
- `SYFT_FILE_METADATA_DIGESTS=sha256` keeps file digests to SHA-256; syft adds SHA-1 by default.
- Measured on the CPU image (syft 1.54.1): about 4,100 components (88 Debian packages, 97 Python packages, the Rust
  crates compiled into Python wheels, and the files those packages own with their SHA-256), 3 MB, under a minute.
  Two Debian packages carry licence IDs newer than CycloneDX 1.6's SPDX list (`SMAIL-GPL`, `Artistic-dist`), so a
  strict schema check flags those two entries.

### AI bill of materials (AI-BOM)

Every version has a CycloneDX 1.6 ML-BOM: `GET /api/minibrains/{slug}/versions/{n}/aibom.json`, or **Download
AI-BOM** on the model card page (`{slug}-v{n}-aibom.cdx.json`, `application/vnd.cyclonedx+json`). It is built from
the same data as the model card, without the deployment history, so deploying or undeploying a version does not
change it.

| Part | CycloneDX | Holds |
|---|---|---|
| The version | `metadata.component`, `machine-learning-model` | Name, number, kind, status, who created it; the recipe (`minibrain:recipe:*`), training and evaluation runs (`minibrain:training:*`, `minibrain:evaluation:*`) as properties; a `model-card` reference to `card.json` |
| Model card | `metadata.component.modelCard` | Task, architecture (LoRA adapter on the base, or the base with the task prompt and few-shot examples), the snapshot as its dataset, the labels; held-out and test accuracy, macro F1, invalid-answer rate, per-label precision, recall, F1 and support, latency p50 and p95 (`quantitativeAnalysis.performanceMetrics`, sliced by split and label); intended use and every derived and written limit (`considerations`) |
| Base model | component, `machine-learning-model` | Repository and revision, `pkg:huggingface` purl, the licence (SPDX ID where one exists, else its name and URL), the content hash as SHA-256, whether it was recorded when training started, who accepted the licence |
| Adapter | component, `file` (LoRA versions only) | The adapter archive's artifact ID, which is the SHA-256 of the tar, its size |
| Training snapshot | component, `data` | The snapshot hash as SHA-256, rows per split, when it was taken, the SQL, every data check and its result, personal data findings as `sensitiveData` |
| Sources | component, `data`, one per table | Table, source kind and fingerprint; uploads also carry the file's SHA-256 as a hash. Folder and remote fingerprints are SHA-256 over a listing or the source's state, so they stay a property |
| Dependencies | `dependencies` | The version on the base, the adapter and the snapshot; the adapter on the base; the snapshot on its sources |

The output is deterministic: the same version gives the same bytes. `metadata.timestamp` is the newest of the
version's creation, its training and evaluation finish times, the base model's licence acceptance and the last card
edit. `metadata.properties` carries `minibrain:aibom:sha256`, the SHA-256 of the canonical BOM: the BOM without
`serialNumber` and `metadata.properties`, as JSON with keys sorted, no whitespace and non-ASCII characters kept (the
model card's canonical form). `serialNumber` is a version 8 UUID made from the first 16 bytes of that digest, so it
changes whenever the content does. Check a download with:

```sh
python3 -c 'import hashlib,json,sys; b=json.load(open(sys.argv[1])); b.pop("serialNumber"); p=b["metadata"].pop("properties"); s=json.dumps(b,sort_keys=True,separators=(",",":"),ensure_ascii=False); print(hashlib.sha256(s.encode()).hexdigest(), p[0]["value"])' support-triage-v1-aibom.cdx.json
```

Both printed values match for an unchanged file. `tests/test_aibom.py` validates prompt-only and trained versions
against the CycloneDX 1.6 JSON schema, vendored in `tests/cyclonedx/` (Apache 2.0) so the test needs no network.
