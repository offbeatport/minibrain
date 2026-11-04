# Third-party notices

Python and web dependencies are listed with their licences in the SBOMs ([security](docs/security.md#software-sbom)).
This file covers what those do not: the DuckDB extensions the Docker image carries.

## DuckDB extensions

The image downloads these from extensions.duckdb.org for its DuckDB version (v2.0.0) and platform, unchanged and
signed by DuckDB (`Dockerfile`, `extensions` stage). The wheel carries none.

| Extension | Source | Licence |
|---|---|---|
| httpfs | [duckdb/duckdb-httpfs](https://github.com/duckdb/duckdb-httpfs) | MIT |
| postgres_scanner | [duckdb/duckdb-postgres](https://github.com/duckdb/duckdb-postgres) | MIT |
| iceberg | [duckdb/duckdb-iceberg](https://github.com/duckdb/duckdb-iceberg) | MIT |
| avro | [duckdb/duckdb-avro](https://github.com/duckdb/duckdb-avro) | MIT |
| delta | [duckdb/duckdb-delta](https://github.com/duckdb/duckdb-delta) at `9dcfb65` | MIT |
| mysql_scanner, only with `INCLUDE_MYSQL=true` | [duckdb/duckdb-mysql](https://github.com/duckdb/duckdb-mysql) | MIT; links the MySQL client library (GPLv2 with the Universal FOSS Exception) |

Each is Copyright 2018-2025 Stichting DuckDB Foundation (avro: 2018-2024), under the MIT License:

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## delta-kernel-rs

The delta extension links [delta-io/delta-kernel-rs](https://github.com/delta-io/delta-kernel-rs) v0.28.0, under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). Its NOTICE:

> The Delta Kernel Rust project
> Copyright 2023-2024 The Delta Kernel Rust Authors
> Licensed under The Apache-2.0 Licence

The kernel's NOTICE lists the crates it includes (arrow-rs, bytes, chrono and others). Among them, the ones that do
network I/O and cryptography, found in the v2.0.0 binaries:

| Crate | Version | Licence |
|---|---|---|
| object_store | 0.13.2 | MIT OR Apache-2.0 |
| reqwest | 0.12.28, 0.13.2 | MIT OR Apache-2.0 |
| hyper-rustls | 0.27.7 | Apache-2.0 OR ISC OR MIT |
| rustls | 0.23.37 | Apache-2.0 OR ISC OR MIT |
| rustls-platform-verifier | 0.6.2 | MIT OR Apache-2.0 |
| ring | 0.17.14 | Apache-2.0 AND ISC |
| aws-lc-rs | 1.16.2 | ISC AND (Apache-2.0 OR ISC) |

minibrain keeps that code off the network: Delta tables are read from folders on the server only
([security](docs/security.md#tls-in-duckdb-extensions)).
