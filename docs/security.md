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

