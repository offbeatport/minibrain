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
| Request logs | Always on, metadata only; retention in days | Hourly purge on the leader ([below](#request-logs)) |
| Request inputs and answers | Default for new models (off), and Lock for every model | Gateway config, per model ([below](#request-logs)) |
| API keys | Expiry in days for new keys | Gateway rejects expired keys with 401, and models the key does not cover with 403 |
| Audit log retention | Days, 0 keeps every event (default) | Hourly prune on the leader, cut at a chain anchor (below) |
| SIEM export | Off (default), TLS, TCP or UDP; host, port (0 is 6514 for TLS, 514 otherwise), CA bundle path | Syslog forwarder on the leader (below) |
| OpenTelemetry export | Off (default) or OTLP over HTTP; collector endpoint, headers (encrypted, write-only), service name, CA bundle path; also `OTEL_EXPORTER_OTLP_*` | Exporters in main and gateways, applied within 5 seconds ([observability](observability.md)) |
| Encryption at rest | Local key file (default), HashiCorp Vault Transit, PKCS#11 HSM, AWS KMS or Off; each provider's settings | Every file main stores (below) |

### Request logs

- Every `/v1` request is logged with its time, model, version, key, status, latency, tokens in and out, finish reason
  and response ID. These hold no content; Monitor, Overview, cost and the Requests tab depend on them, so there is no
  switch to turn them off. Log retention deletes them.
- A request's input (the last user message) and the model's answer are kept only for models whose "Keep request inputs
  and answers" switch is on, on the model's deployment page. Off by default. Builders change it; each change is audited
  as `model.request_bodies` with the value before and after. Kept inputs and answers let apps send feedback with the
  response ID alone, feed distillation, and show on the Requests tab to Builders and Admins. They are stored in the
  database next to the request log and deleted with it.
- The Request inputs and answers policy is the default for new models, and the setting for base models served through
  `/v1`. Lock for every model (`request_bodies_locked`) makes every model follow it: each model's switch shows the
  value and cannot be changed, and Builders get a 409. Setting `request_bodies` in `minibrain.yaml` or
  `MINIBRAIN_POLICY_REQUEST_BODIES` locks it for every model too, unless `request_bodies_locked: false` is set beside it.
- `POST /v1/feedback` without `input` for a model that does not keep them returns 422 and names the model's switch.
- Gateways, standalone ones included, get each model's value in their config snapshot, within a second of a change.

## Accounts and sign-in

People sign in to the UI and `/api`; apps call `/v1` with API keys only, and workers and engines keep their tokens.

| Source | How | Notes |
|---|---|---|
| Local accounts | Email and password; an admin adds people with a one-time set-password link (24 hours), or `minibrain admin create` on the server | PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte salt, through `cryptography`; 10 failures lock the account for 15 minutes |
| OIDC | Authorization code with PKCE (S256) through Authlib; the ID token is checked with joserfc (issuer, audience, expiry, nonce, signature from the provider's JWKS; RSA, RSA-PSS or ECDSA only) | The issuer must match discovery; state, nonce and verifier sit in a signed, HttpOnly cookie for 10 minutes |
| Proxy headers | `X-Forwarded-User`, `-Email`, `-Groups` (names configurable) | Honoured only from `auth.proxy.addresses`; the same headers from anywhere else are ignored |

- Accounts are always on: everyone who opens the UI or calls `/api` signs in, on loopback too. Audit events name
  the person; workers, engines and `/v1` keep their tokens and API keys.
- Sessions: a random 256-bit token in an HttpOnly, SameSite=Lax cookie; the database keeps only its SHA-256. Idle
  and absolute lifetimes are the `session_idle_minutes` (480, a working day) and `session_hours` (168, a week) policies. Signing out, a new
  password or turning an account off ends sessions at once.
- The cookie is Secure when the request is HTTPS, a configured proxy says it was (`X-Forwarded-Proto`), or the
  browser's `Origin` is HTTPS. Plain HTTP on loopback (`localhost`, `127.0.0.1`, `::1`) gets no Secure flag, since
  Safari drops Secure cookies on `http://localhost`. Plain HTTP on any other address gets it, so the browser keeps
  no session there, and the sign-in page says to use TLS or localhost.
- CSRF: every state-changing `/api` call from a signed-in person carries `X-CSRF-Token`, an HMAC-SHA256 of the
  session (or proxy identity) under a per-install key.
- Forwarded client addresses (`X-Forwarded-For`, `X-Forwarded-Proto`) count only from `auth.proxy.addresses`;
  uvicorn's own proxy-header handling is off.
- Roles: Viewer, Builder and Admin, enforced by one guard per `/api` route; `tests/test_access.py` lists every route
  with its role. Viewers get versions, jobs and model details without data rows.
- The OIDC provider is called directly by main (discovery, JWKS, token); the network policy does not apply to it,
  since an admin configured it. `auth.oidc.ca_bundle` trusts an internal CA.

```yaml
auth:
  default_role: none                  # none, viewer, builder or admin for people with no mapped group
  admins: [ada@corp.example]          # emails or user names that are always admins; locked in Settings > Accounts
  roles:                              # identity provider group -> role; locked in Settings > Accounts
    minibrain-admins: admin
    ml-team: builder
  proxy:
    addresses: [10.0.0.10/32]         # only these may send identity headers
  oidc:
    issuer: https://keycloak.corp/realms/corp
    client_id: minibrain
    client_secret_file: /run/secrets/oidc   # or MINIBRAIN_OIDC_CLIENT_SECRET; omit for a public client
    label: Keycloak
    groups_claim: groups
```

### First admin

| Way | For | How |
|---|---|---|
| Setup link | The default, native and Docker | The first start with no accounts prints a one-time link that creates the admin |
| Environment | Automated deploys | `MINIBRAIN_ADMIN_EMAIL` and `MINIBRAIN_ADMIN_PASSWORD_FILE` create the admin on the first start |
| Single sign-on | OIDC or proxy headers | A group mapped to admin, or a person in `auth.admins`, in `minibrain.yaml`; no local admin and no setup link |
| Command line | Recovery | `minibrain admin create` adds an admin; `minibrain admin reset-password` sets a new password |

Setup link:

- `minibrain serve` prints it once main listens, to standard output, so it lands in the terminal or the container
  log: `http://127.0.0.1:8000/setup?token=…`. On a desktop terminal it also opens it in the browser; not in Docker,
  CI, over SSH or without a TTY, and never with `--no-browser`.
- The token is 256 random bits from `secrets`. The database keeps only its SHA-256 (in `app_settings`), so the link
  survives restarts until it is used. It works once, and creating the admin any other way voids it. Later starts
  print a reminder instead of the link, since minibrain cannot show it again.
- Lost it: `minibrain admin setup-link` prints a new link and voids the old one; `--url https://minibrain.corp`
  names the address people use. In Docker: `docker logs minibrain | grep setup`, or
  `docker exec minibrain minibrain admin setup-link`.
- The link names the address main listens on (`127.0.0.1:8000` unless `--host` or `--port` change it). Opening
  minibrain at another address, keep the path and the token. The page asks for the token when the link lacks it.

Environment, for automated deploys:

- `MINIBRAIN_ADMIN_EMAIL` with `MINIBRAIN_ADMIN_PASSWORD_FILE`, a file such as a Docker or Kubernetes secret that
  holds the password (a trailing newline is dropped). Read on the first start only, and ignored once any account
  exists, so changing them later changes nothing.
- A plain `MINIBRAIN_ADMIN_PASSWORD` works too, but logs a warning recommending the file: environment variables show
  in `docker inspect` and process listings. minibrain never logs the password.
- A missing or unreadable password file, a password under 12 characters or a malformed email stops the start with
  the reason.

Single sign-on only: with `auth.oidc` or `auth.proxy` set and `auth.roles` mapping a group to admin, `auth.admins`
listing people by email or user name (or `auth.default_role: admin`), no local admin is needed. minibrain issues no setup link; the first page is sign-in, and
whoever signs in from the admin group is an admin. `minibrain admin create` still adds a local admin, such as a
break-glass account. With single sign-on but no admin group, the setup link is issued as usual.

Recovery: `minibrain admin reset-password --email you@example.com` sets a new password for a local account, clears
a lockout and ends its sessions; `minibrain admin create --email you@example.com` adds another admin. Both ask for the
password, or read it with `--password-stdin`, and record `command line` as the actor in the audit log.

## Trust zones and ports

| Zone | Holds | Accepts connections from | Ports |
|---|---|---|---|
| Corporate network | Apps, browsers | | |
| Edge | Load balancers | The corporate network | 443 |
| Internal network | Gateways, mains, Postgres, S3 | The edge; GPU pools reach main only | gateway 8100, main 8000, Postgres 5432, S3 443 |
| GPU network | Workers, engines | Engines: gateways only. Workers: nothing | Outbound HTTPS to main 8000, and to the bucket endpoint when Storage is S3 |

- GPU boxes need no internet access: engines and workers pull adapters and dataset versions from `main`, and base weights
  from `main` or, when Storage is S3, from the bucket on links `main` signs. They never hold bucket keys.
- Workers and engines hold a shared token (`MINIBRAIN_WORKER_TOKEN`, `MINIBRAIN_GATEWAY_TOKEN`), never database
  credentials.
- Identity headers from a reverse proxy are trusted only when the request comes from a configured proxy address.
- Deleting a model writes an audit event with who, what and its size.
- No outbound telemetry. With the Offline network policy nothing leaves the install, except audit events to the SIEM
  you configure, traces and metrics to the OpenTelemetry collector you configure, the Vault or AWS KMS that holds the
  master key, and artifact storage you point at a bucket. Settings → This install lists the SIEM, collector and
  bucket; Settings → Security shows the key service. The OTLP exporter ignores proxy variables and does not follow redirects.
- `/metrics` is off until `metrics.addresses` or a scrape token is set, and then needs that address or token, not a
  session ([observability](observability.md#prometheus)).
- Every response carries an `X-Request-ID`, and JSON logs (`MINIBRAIN_LOG_FORMAT=json`) carry it on each line.
- Content hashes and signatures use SHA-256 through OpenSSL or `cryptography`; never MD5 or SHA-1.
- DuckDB extensions are native code; the one that does its own TLS (delta) is kept off the network
  ([below](#tls-in-duckdb-extensions)).

## TLS in DuckDB extensions

S3, Iceberg and Delta Lake sources are read by DuckDB extensions, native code that the Python crypto checks cannot see.
Checked on DuckDB v2.0.0 (osx_arm64 and linux_amd64 builds from extensions.duckdb.org):

| Extension | Sources | TLS and S3 request signing |
|---|---|---|
| httpfs | S3, Iceberg data and metadata | OpenSSL 3.6.0, linked into the extension |
| iceberg, avro | Iceberg | None of their own: they read through httpfs |
| delta | Delta Lake | The table log: delta-kernel-rs's own client, object_store 0.13.2 over reqwest and rustls 0.23 with ring 0.17 (aws-lc-rs is linked too), SigV4 signed with ring's HMAC. Data files: httpfs |

So minibrain reads Delta tables only from folders on the server, inside Settings → Security → Folder sources: local
disk, NFS or SMB, or a bucket mounted by a client whose TLS you control. `s3://`, `https://` and every other URL is
refused when the source is added, and dataset SQL cannot call `delta_*` functions. On a local path the kernel opens no
connection and does no cryptography: the extension checks DuckDB's `allowed_directories` (the table's folder), the
kernel reads `_delta_log` itself, and DuckDB reads the data files through its own file system. A `_delta_log` that is
a symbolic link is refused.

Evidence:

- Build: DuckDB v2.0.0 pins duckdb-delta at `9dcfb65`, whose `CMakeLists.txt` builds delta-kernel-rs v0.28.0 with
  `--features default-engine-rustls`. Its scan code says the kernel "resolves the table location using its own file
  and HTTP I/O, outside of the file systems of DuckDB".
- Binary: `delta.duckdb_extension` has no OpenSSL (no `SSL_CTX_new`, no OpenSSL version string; httpfs has both) and
  carries rustls 0.23.37, ring 0.17.14, aws-lc-rs 1.16.2, hyper-rustls and object_store 0.13.2; `otool -L` shows
  only system libraries. `object_store::util::hmac_sha256` calls `ring::hmac::Key::new` and `ring::hmac::sign`.
- Run: S3 (moto) over TLS with a private CA, behind a proxy that logs each ClientHello. With DuckDB's
  `ca_cert_file` (an OpenSSL setting) pointing at the CA, `read_parquet` over httpfs succeeds with OpenSSL's
  ClientHello (30 cipher suites with CBC and DHE, X25519MLKEM768 offered). `delta_scan` on the same connection fails
  in the kernel (`DeltaKernel ObjectStoreError`, "error sending request" after 10 retries), each attempt a rustls
  ClientHello (9 AEAD suites and the renegotiation SCSV, no CBC, groups X25519, P-256 and P-384: ring's set). Over
  plain HTTP, the log requests carry `User-Agent: object_store/0.13.2` and the data file reads `duckdb/v2.0.0`.

Re-check after a DuckDB upgrade: `strings -a delta.duckdb_extension | grep -E 'rustls-|ring-|^OpenSSL [0-9]'`. Delta
on S3 can come back when the kernel reads its log through DuckDB's file system or is built with
`default-engine-native-tls` against OpenSSL; a self-built extension would also need DuckDB's unsigned extensions
setting, which minibrain keeps off.

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

## Encryption at rest

Every file minibrain stores is encrypted with its own random 256-bit data key, and that data key is wrapped by a
master key that lives somewhere else: a local key file (the default), HashiCorp Vault Transit, a PKCS#11 HSM, or AWS
KMS. Settings → Security → Encryption at rest picks the provider, tests it before saving, shows which key each file
uses, and starts checks, rotations and the encryption of older files. Everything there is admin-only, audited, and
locked when `minibrain.yaml` (`policy:`) or `MINIBRAIN_POLICY_<NAME>` sets it.

### What is encrypted

| Kept by main | Encrypted | Notes |
|---|---|---|
| Uploads, dataset versions, adapters, job logs (the artifact store) | Yes, in the local folder and in an S3 bucket | The bucket only ever holds ciphertext (client-side encryption) |
| Staging databases built from uploads (`<home>/staging`) | Yes | Built in a private temporary folder, sealed, and the plaintext removed straight away |
| Connection secrets and sealed settings (OpenTelemetry headers) | Yes, same master key | One AES-256-GCM envelope per value, the row's id as associated data |
| The database (SQLite or Postgres) | No | Request inputs and answers kept for the models you choose live there: put SQLite on an encrypted volume, or use Postgres with storage encryption |
| Base model weights in an S3 bucket | Yes | Each file is a sealed artifact under its SHA-256, like every other one |
| Base model weights on main's disk (`<home>/models`, Storage set to the folder) | No | Public weights; imported private weights are not encrypted by minibrain either |

Main never writes decrypted copies of these files. DuckDB reads dataset versions, uploads and staging databases through a
filesystem that decrypts on the fly, a chunk at a time, so queries, previews, diffs and the gateway's prompt context
work on the encrypted files directly (the sandbox still refuses every path it was not given). The trade-off is a
little CPU per read (measured below) instead of a decrypted cache on disk.

Workers, engines and gateways are different: training, evaluation and serving read plain files, and those machines
hold no master key. Main decrypts an artifact when a worker or engine pulls it over HTTPS, and the worker's or
engine's own home (`<home>/worker`, `<home>/engines`, `<home>/gateway`) holds plain working copies of the dataset
versions and adapters it uses. Put those folders on an encrypted volume (or tmpfs) on GPU boxes; they are caches and can be
wiped at any time. A worker's outputs are encrypted the moment main stores them.

### Base weights on other machines

With Storage on S3, base model files stay sealed in the bucket and machines read them from there, not through main:

1. A worker or engine asks main over its authenticated channel (`GET /internal/worker/bases/<key>` with the worker
   token, `/internal/gateway/bases/<key>` with the gateway token).
2. Main answers, with `Cache-Control: no-store`, each file's path, size and SHA-256, a presigned GET link (SigV4,
   valid 15 minutes, for the configured endpoint and nothing else) and the file's data key: main reads the object's
   4 KiB header with its own bucket credentials and unwraps the data key with the master key, through the same
   provider as every other unwrap (`cryptography`, Vault Transit, the HSM or KMS).
3. The machine downloads the object, decrypts the STREAM format chunk by chunk with AES-256-GCM through
   `cryptography`, checks the plaintext's size and SHA-256 against the saved list, and only then renames the file into
   its working copy. A changed byte, chunk or header fails authentication or the hash, and the file is refused.

The machine never holds the bucket's keys or the master key. A data key opens one object only (each file has its
own), stays in memory and is never written to disk; a verify job takes its links and keys on standard input, not in
its job file. The node channel carried these files' plaintext before, so it carries nothing it did not; run it over
HTTPS. Working copies are plaintext, as engines need, so treat `<home>/models`, `<home>/engines` and
`<home>/worker/models` like the other plain working copies above.

### File format

A sealed file is a 4,096-byte header followed by the body in chunks.

| Bytes | Field |
|---|---|
| 0-7 | Magic `89 4D 42 45 0D 0A 1A 0A` |
| 8 | Format version, 1 |
| 9 | Cipher suite, 1: AES-256-GCM in a STREAM construction |
| 10-11 | Reserved, zero |
| 12-15 | Chunk size in plaintext bytes, big-endian (1 MiB) |
| 16-22 | Random 7-byte nonce prefix |
| 23-63 | Reserved, zero |
| 64-2079 | Key slot A |
| 2080-4095 | Key slot B |

- Body: each plaintext chunk is encrypted with AES-256-GCM under the file's data key, with the 96-bit nonce
  `prefix ‖ chunk index (4 bytes, big-endian) ‖ final flag (1 byte)`, the first 64 header bytes as associated data,
  and a 16-byte tag appended. Every chunk but the last is exactly `chunk size + 16` bytes. Reordering, dropping,
  duplicating or appending chunks, cutting the file at a chunk boundary or anywhere else, and changing a header byte
  all fail authentication. Each data key encrypts one file only, so a nonce never repeats under a key.
- Key slot: a sequence number (4 bytes), the length of a JSON payload (2 bytes), the payload, zero padding, and the
  slot's SHA-256 in its last 32 bytes. The payload is `{"p": provider, "k": key reference, "w": wrapped data key}`.
  Readers use the valid slot with the highest sequence number; the other one lets re-wrapping replace a header in
  place without a moment where a crash leaves the file unreadable.
- The wrapped data key is bound to the file: the wrap's associated data (local key, HSM), encryption context (KMS) or
  wrapped plaintext (Vault, which carries the SHA-256 of the context next to the key) holds `minibrain.artifact.<id>`
  for artifacts and `minibrain.staging.<key>` for staging databases, so a header copied onto another file does not
  open.
- Files without the magic are read as plaintext, so files written before encryption at rest stay readable.
- Plaintext size is the file size minus the header and 16 bytes per chunk, so random access needs no index.

Content hashes stay over the plaintext: an artifact's id is still the SHA-256 of its plain bytes. Identical uploads
and dataset versions are still stored once, a re-saved version still matches its earlier copy, and model cards and AI-BOMs
keep the hashes customers can check against their own files. The hash says only what any copy of the same content
would hash to, which the content-addressed file name already revealed.

### Key providers

| Provider | Master key | Wrapped by | Rotation |
|---|---|---|---|
| Local key file (default) | `<home>/keys/master.key` (folder 0700, file 0600), made on first start; or the file `MINIBRAIN_MASTER_KEY_FILE` names, such as a Kubernetes or Docker secret | AES-256-GCM through `cryptography`, random 96-bit nonce, the file's context as associated data | `minibrain keys rotate` adds a key to the file. A mounted file is never written: add a line yourself |
| HashiCorp Vault Transit | An `aes256-gcm96` Transit key | Transit `encrypt` and `decrypt` over HTTPS (httpx, TLS 1.2+ through Python's `ssl`), token or AppRole | Transit's key rotate, then re-wrap |
| PKCS#11 HSM | Non-extractable AES-256 key objects with one label, the version as `CKA_ID` | `C_Encrypt` with `CKM_AES_GCM` inside the HSM, random 96-bit IV, the context's SHA-256 as associated data (PyKCS11) | A new key object, then re-wrap |
| AWS KMS | A symmetric KMS key | KMS `Encrypt` and `Decrypt` through botocore, the context's SHA-256 as encryption context | KMS rotates key material itself; point minibrain at a new key ARN to move every data key |

Local key file. The file holds one base64 256-bit key per line; the last line is the current key and the others stay
readable. The same key seals files and connection secrets, so there is one key for everything. Back the key up separately from the data: a
backup that holds both protects nothing, and data whose key is lost cannot be read. With more than one main, every
main needs the same key file: mount it from your secret store and set `MINIBRAIN_MASTER_KEY_FILE`. A main that finds
the install already encrypting under a local key it does not have refuses to make its own and says so.

```sh
openssl rand -base64 32 > /run/secrets/minibrain-master.key   # then MINIBRAIN_MASTER_KEY_FILE=/run/secrets/minibrain-master.key
```

HashiCorp Vault Transit.

```sh
vault secrets enable transit
vault write -f transit/keys/minibrain type=aes256-gcm96
vault policy write minibrain - <<'HCL'
path "transit/encrypt/minibrain"     { capabilities = ["update"] }
path "transit/decrypt/minibrain"     { capabilities = ["update"] }
path "transit/keys/minibrain"        { capabilities = ["read"] }
path "transit/keys/minibrain/rotate" { capabilities = ["update"] }
HCL
vault auth enable approle
vault write auth/approle/role/minibrain token_policies=minibrain token_ttl=1h
```

```yaml
policy:
  encryption: vault
  vault_address: https://vault.internal:8200
  vault_auth: approle               # or token, read from MINIBRAIN_VAULT_TOKEN(_FILE)
  vault_role_id: 7f1c…              # the secret ID comes from MINIBRAIN_VAULT_SECRET_ID(_FILE)
  vault_ca_bundle: /etc/minibrain/vault-ca.pem
  vault_namespace: ""               # Vault Enterprise only
```

Drop the `rotate` path from the policy if Vault admins rotate the key themselves; minibrain then re-wraps to whatever
version is newest. Tested against Vault 1.20.4 in dev mode with AppRole.

PKCS#11 HSM. Install the extra (`pip install 'minibrain[hsm]'`, which adds PyKCS11) and the vendor's PKCS#11 module.

```yaml
policy:
  encryption: hsm
  hsm_library: /usr/lib/softhsm/libsofthsm2.so   # the vendor module
  hsm_token: minibrain                          # token (partition) label
  hsm_key: minibrain-master                     # key label; the PIN comes from MINIBRAIN_HSM_PIN(_FILE)
```

If the token has no key with that label the first time minibrain uses it, minibrain generates one (AES-256,
sensitive, not extractable, `CKA_ID` 1); create it yourself if your HSM policy reserves key generation for its
officers. Tested against SoftHSM 2.7.0.

AWS KMS. Credentials come from the server's AWS environment (variables, profile, web identity on EKS, or the instance
role); nothing calls AWS unless KMS is the provider.

```yaml
policy:
  encryption: kms
  kms_key: arn:aws:kms:us-gov-west-1:111122223333:key/1234abcd-…
  kms_fips: true                    # kms-fips.<region>.amazonaws.com
  kms_endpoint: ""                  # an https:// VPC endpoint, if you use one
```

The IAM policy needs `kms:Encrypt`, `kms:Decrypt` and `kms:DescribeKey` on the key. With S3 storage on AWS,
SSE-KMS on the bucket is a useful second layer: it protects the objects at the storage layer and logs every read in
CloudTrail, but it decrypts for anyone holding the bucket credentials, while minibrain's client-side layer keeps the
bucket's contents unreadable without the master key.

The network policy does not apply to Vault or KMS, as it does not to artifact storage: an admin chose them.
Switching provider tests a wrap and an unwrap first and refuses the change if either fails; files wrapped under the
old provider stay readable as long as its settings stay in place.

### Rotation, checks and older files

| Action | Command | UI | What it does |
|---|---|---|---|
| Check | `minibrain keys status` | Check now | Reads every header and counts files under the current key, under older keys, unencrypted and unreadable, per key |
| Rotate | `minibrain keys rotate` | Rotate master key | Makes a new master key version, then re-wraps every data key under it |
| Encrypt older files | `minibrain keys encrypt-existing` | Encrypt existing files | Encrypts files written before encryption at rest, in place |

- Re-wrapping rewrites only the header: unwrap with the old key, wrap with the new one, write the free slot, sync,
  then clear the old slot. File bodies are never re-encrypted. A bucket object is rewritten in the bucket: a multipart
  upload whose first part is the new header and the object's first 5 MiB, and whose other parts the bucket copies from
  the old object (`UploadPartCopy`, pinned to its ETag), so only 5 MiB leave main however large the file; an object
  under 5 MiB is sent again whole. Secrets are resealed in the same pass.
- Older local key versions stay readable until a pass finds nothing uses them and the new key is at least an hour
  old; the leader runs that check on its own and then drops them from the key file (`--retire-now` skips the wait
  when no server is running). Vault, HSM and KMS keep their versions: retire them there.
- Encrypting an older file writes an encrypted copy beside it, reads the copy back and checks its SHA-256 against the
  file's id, then swaps the two atomically; a file whose content does not match its id is left alone and reported.
  The same pass deletes leftover plaintext staging files and main's old decrypted cache.
- In the UI these run as one background pass on the leader, with progress; each is audited (`encryption.rotate`,
  `encryption.rewrap`, `encryption.encrypt_existing`, `encryption.check`, `encryption.retire`, `encryption.key`).
- Rotation answers "a key version should no longer be used"; it does not make copies of files taken before the
  rotation unreadable to someone who also has the old key.

### Turning it on later

Encryption at rest is on by default: on first start main makes the local key and every file is encrypted. Set the
master key to Off (`MINIBRAIN_POLICY_ENCRYPTION=off`) only for a multi-main install whose mains do not share a key file
yet. Turned on again, every new file is encrypted and files stored while it was off stay readable as they are; run
`minibrain keys encrypt-existing` or press Encrypt existing files when convenient, without downtime.

### Performance

Measured on an Apple M1 Pro (macOS, `cryptography` 50.0.2 on OpenSSL 4.0.3) with a 1 GiB file of random bytes,
reading and writing the local SSD, best of two runs:

| Operation | Plaintext (before) | Encrypted |
|---|---|---|
| Store: read, SHA-256, write | 1,009 MB/s | 712 MB/s |
| Read: read, SHA-256 | 1,929 MB/s | 1,427 MB/s |
| AES-256-GCM alone, in memory, 1 MiB chunks | | 4,349 MiB/s encrypt, 2,104 MiB/s decrypt |

Memory stays flat: 1 MiB chunks are encrypted and decrypted one at a time, and random reads keep at most 8 decrypted
chunks per open file.

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

Each release carries one SBOM per image, `minibrain-image-{cpu,cuda}-{amd64,arm64}.cdx.json`: the release workflow
loads the image it pushes into Docker and runs syft on it, with the settings below, and attests the SBOM on that
image in GHCR. CI does not build the image (the CUDA one is about 7 GB). Its Python packages are the
`--no-dev --extra postgres --extra qlora` subset of `minibrain-python.cdx.json`, except torch, which comes from the
PyTorch index as the CUDA or CPU build. For a local build, operating system packages included, run syft against the
built image:

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

### Signed releases

Every release file and image is signed keyless through Sigstore by the release workflow at its tag, and the SBOMs
and SLSA build provenance are attested on the images. No signing key exists to leak. Verifying, online or air-gapped
with the bundles and Sigstore's trusted root: [Install → Verify a release](install.md#verify-a-release); how it is
made: [Releasing → Signing and provenance](releasing.md#signing-and-provenance).

### AI bill of materials (AI-BOM)

Every version has a CycloneDX 1.6 ML-BOM: `GET /api/models/{slug}/versions/{n}/aibom.json`, or **Download
AI-BOM** on the model card page (`{slug}-v{n}-aibom.cdx.json`, `application/vnd.cyclonedx+json`). It is built from
the same data as the model card, without the deployment history, so deploying or undeploying a version does not
change it.

| Part | CycloneDX | Holds |
|---|---|---|
| The version | `metadata.component`, `machine-learning-model` | Name, number, kind, status, who created it; the recipe (`minibrain:recipe:*`), training and evaluation runs (`minibrain:training:*`, `minibrain:evaluation:*`) as properties; a `model-card` reference to `card.json` |
| Model card | `metadata.component.modelCard` | Task, architecture (LoRA adapter on the base, or the base with the task prompt and few-shot examples), the dataset version as its dataset, the labels; held-out and test accuracy, macro F1, invalid-answer rate, per-label precision, recall, F1 and support, latency p50 and p95 (`quantitativeAnalysis.performanceMetrics`, sliced by split and label); intended use and every derived and written limit (`considerations`) |
| Base model | component, `machine-learning-model` | Repository and revision, `pkg:huggingface` purl, the licence (SPDX ID where one exists, else its name and URL), the content hash as SHA-256, whether it was recorded when training started, who accepted the licence |
| Adapter | component, `file` (LoRA versions only) | The adapter archive's artifact ID, which is the SHA-256 of the tar, its size |
| Training dataset version | component, `data` | The dataset version hash as SHA-256, rows per split, when it was taken, the SQL, every data check and its result, personal data findings as `sensitiveData` |
| Sources | component, `data`, one per table | Table, source kind and fingerprint; uploads also carry the file's SHA-256 as a hash. Folder and remote fingerprints are SHA-256 over a listing or the source's state, so they stay a property |
| Dependencies | `dependencies` | The version on the base, the adapter and the dataset version; the adapter on the base; the dataset version on its sources |

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
