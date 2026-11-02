# Security

## Policies

Settings → Security. Values from `minibrain.yaml` (`policy:`) or `MINIBRAIN_POLICY_<NAME>` are locked in the UI and
show "Set by config file" or "Set by environment"; the rest are editable, and every change is written to the audit
log with who, before and after.

| Policy | Values | Enforced at |
|---|---|---|
| Network | Open, Allowlist (hosts), Offline (`MINIBRAIN_OFFLINE` forces it) | Downloads, retries, S3 imports, catalogue sync, Add from Hugging Face, the online check |
| Model sources | Approved publishers, any (badged untested), imports only | Download, retry, Add from Hugging Face |
| Licences | Allowlist of reviewed licences; unreviewed ones off by default | Download, retry |
| Safetensors only | Always on | Download file filter; pickle weights are never loaded |
| Request logs | On or off, retention in days | Gateway config; hourly purge on the leader |
| API keys | Expiry in days for new keys | Gateway rejects expired keys with 401 |

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
- No outbound telemetry. With the Offline network policy nothing leaves the install.
- Content hashes and signatures use SHA-256 through OpenSSL or `cryptography`; never MD5 or SHA-1.
