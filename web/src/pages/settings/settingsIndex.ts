import type { Role } from "~/api/authQueries";

export type SettingsPath =
    | "/settings"
    | "/settings/security"
    | "/settings/accounts"
    | "/settings/audit"
    | "/settings/data"
    | "/settings/storage"
    | "/settings/connections"
    | "/settings/install";

type Words = readonly string[];

export type Setting = {
    anchor: string;
    label: string;
    description: string;
    keywords: Words;
    aliases?: Words;
    policy?: string;
};

type SettingSpec = Omit<Setting, "anchor"> & { anchor?: string };

type SectionOptions = { role?: Role; description?: string; keywords?: Words };

export type SettingsSection<T extends Record<string, Setting> = Record<string, Setting>> = {
    anchor: string;
    title: string;
    role?: Role;
    description?: string;
    keywords: Words;
    settings: T;
};

export type IndexEntry = {
    key: string;
    path: SettingsPath;
    anchor: string;
    sectionAnchor: string;
    section: string;
    role?: Role;
    label: string;
    description: string;
    keywords: Words;
    aliases?: Words;
    policy?: string;
};

function slug(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

function keyAnchor(key: string): string {
    return slug(key.replace(/([a-z])([A-Z])/g, "$1-$2"));
}

export function policyAnchor(name: string): string {
    return slug(name);
}

function setting(label: string, description: string, keywords: Words = []): SettingSpec {
    return { label, description, keywords };
}

const ON_SECTION = "\u0000section";

function at(anchor: string, spec: SettingSpec): SettingSpec {
    return { ...spec, anchor };
}

function onSection(spec: SettingSpec): SettingSpec {
    return at(ON_SECTION, spec);
}

function pageTop(spec: SettingSpec): SettingSpec {
    return at("", spec);
}

function aka(aliases: Words, spec: SettingSpec): SettingSpec {
    return { ...spec, aliases };
}

function policy(
    name: string,
    keywords: Words = [],
    shown?: { label: string; description: string },
): SettingSpec {
    return {
        policy: name,
        anchor: policyAnchor(name),
        label: shown?.label ?? "",
        description: shown?.description ?? "",
        keywords,
    };
}

function section<T extends Record<string, SettingSpec>>(
    title: string,
    specs: T,
    options: SectionOptions = {},
): SettingsSection<{ [K in keyof T]: Setting }> {
    const own = slug(title);
    const rows = Object.entries(specs).map(([key, spec]) => spec.anchor ?? keyAnchor(key));
    const anchor = rows.includes(own) ? `${own}-section` : own;
    const settings = Object.fromEntries(
        Object.entries(specs).map(([key, spec]) => [
            key,
            {
                ...spec,
                anchor: spec.anchor === ON_SECTION ? anchor : (spec.anchor ?? keyAnchor(key)),
            },
        ]),
    ) as { [K in keyof T]: Setting };
    return {
        anchor,
        title,
        role: options.role,
        description: options.description,
        keywords: options.keywords ?? [],
        settings,
    };
}

export const GENERAL = {
    appearance: section("Appearance", {
        theme: aka(
            ["dark mode", "light mode"],
            onSection(
                setting("Theme", "Light, dark, or follow your device.", [
                    "dark mode",
                    "light mode",
                    "night",
                    "colour scheme",
                    "color scheme",
                    "system",
                ]),
            ),
        ),
    }),
    catalogue: section(
        "Model catalogue",
        {
            catalogueUpdates: setting(
                "Catalogue updates",
                "Check the model catalogue for newer entries now.",
                ["sync", "refresh", "update", "hub", "hugging face"],
            ),
            dailySync: setting("Check every day", "Looks for a newer catalogue once a day.", [
                "schedule",
                "automatic",
                "sync",
                "daily",
                "cron",
            ]),
        },
        { role: "admin" },
    ),
    prices: section(
        "Compute prices",
        {
            currency: setting(
                "Currency",
                "Used for every price below. No exchange rates: changing it relabels the prices.",
                ["usd", "eur", "gbp", "money"],
            ),
            hourly: onSection(
                setting(
                    "Price per hour",
                    "What an hour of each pool's GPU time costs, so scores show cost per 1,000 requests.",
                    ["cost", "pricing", "gpu", "rate", "hourly", "pool", "budget"],
                ),
            ),
        },
        { role: "admin" },
    ),
    recipe: section(
        "Default training recipe",
        {},
        {
            description:
                "The epochs, learning rate, LoRA rank and other values new training runs start from.",
            keywords: [
                "epochs",
                "learning rate",
                "lora",
                "rank",
                "alpha",
                "batch size",
                "gradient accumulation",
                "hyperparameters",
                "max rows",
            ],
        },
    ),
    splits: section(
        "Dataset splits",
        {},
        {
            description:
                "The most rows kept for the test set, held-out and few-shot examples, and the fewest rows to train on.",
            keywords: [
                "test set",
                "golden",
                "eval",
                "held-out",
                "holdout",
                "few-shot",
                "shots",
                "validation",
                "minimum rows",
            ],
        },
    ),
};

const TLS_WORDS = ["certificate", "ca", "tls", "pem", "trust"];

export const SECURITY = {
    network: section("Network", {
        network: policy("network", [
            "egress",
            "outbound",
            "internet",
            "offline",
            "air-gapped",
            "air gap",
            "firewall",
        ]),
        allowedHosts: policy("allowed_hosts", [
            "allowlist",
            "whitelist",
            "domains",
            "mirror",
            "egress",
        ]),
    }),
    models: section("Models", {
        modelSources: policy("model_sources", [
            "publishers",
            "hugging face",
            "huggingface",
            "hub",
            "downloads",
            "imports",
        ]),
        licenceMode: policy("licence_mode", ["license", "commercial", "non-commercial", "terms"], {
            label: "Allow any licence",
            description: "Only the licences ticked below, each reviewed for commercial use.",
        }),
        licences: at(
            policyAnchor("licence_mode"),
            policy("licences", ["license", "apache", "mit", "llama", "commercial"]),
        ),
        safetensorsOnly: policy("safetensors_only", [
            "pickle",
            "weights",
            "code execution",
            "malware",
        ]),
    }),
    data: section("Data", {
        dataFolders: policy("data_folders", [
            "folders",
            "paths",
            "directories",
            "file system",
            "delta lake",
            "mounts",
        ]),
    }),
    signIn: section("Sign-in", {
        defaultRole: policy("default_role", [
            "sso",
            "single sign-on",
            "oidc",
            "proxy",
            "new users",
            "groups",
        ]),
        sessionIdle: aka(
            ["idle timeout", "session timeout"],
            policy("session_idle_minutes", [
                "timeout",
                "idle",
                "inactivity",
                "sign out",
                "logout",
                "session",
            ]),
        ),
        sessionHours: policy("session_hours", [
            "session",
            "lifetime",
            "expiry",
            "sign in again",
            "logout",
        ]),
    }),
    requestLogs: section("Request logs and API keys", {
        requestBodies: policy("request_bodies", [
            "prompts",
            "answers",
            "payloads",
            "bodies",
            "outputs",
            "logging",
            "privacy",
            "pii",
        ]),
        requestBodiesLocked: policy("request_bodies_locked", ["lock", "per model", "enforce"]),
        logRetention: policy("log_retention_days", [
            "retention",
            "delete",
            "logs",
            "purge",
            "keep",
        ]),
        keyExpiry: aka(
            ["token expiry"],
            policy("key_expiry_days", ["api keys", "tokens", "expire", "rotation"]),
        ),
    }),
    auditExport: section("Audit log export", {
        siemProtocol: aka(
            ["syslog"],
            policy("siem_protocol", [
                "syslog",
                "splunk",
                "sentinel",
                "qradar",
                "audit export",
                "rfc 5424",
                "tls",
            ]),
        ),
        siemHost: policy("siem_host", ["syslog", "siem", "host"]),
        siemPort: policy("siem_port", ["syslog", "6514", "514"]),
        siemCaBundle: policy("siem_ca_bundle", TLS_WORDS),
    }),
    otel: section("OpenTelemetry export", {
        otelProtocol: aka(
            ["otlp", "otel"],
            policy("otel_protocol", [
                "otlp",
                "otel",
                "traces",
                "metrics",
                "observability",
                "telemetry",
            ]),
        ),
        otelEndpoint: policy("otel_endpoint", ["collector", "otlp", "url"]),
        otelHeaders: policy("otel_headers", ["authorization", "bearer", "token"]),
        otelServiceName: policy("otel_service_name", ["service.name", "service"]),
        otelCaBundle: policy("otel_ca_bundle", TLS_WORDS),
    }),
    encryption: section("Encryption at rest", {
        encryption: aka(
            ["kms", "hsm", "vault"],
            policy("encryption", [
                "master key",
                "kms",
                "hsm",
                "vault",
                "envelope",
                "key management",
                "byok",
                "cmk",
            ]),
        ),
        vaultAddress: policy("vault_address", ["hashicorp", "vault", "transit", "url"]),
        vaultMount: policy("vault_mount", ["vault", "transit", "mount path"]),
        vaultKey: policy("vault_key", ["vault", "transit key", "aes256-gcm96"]),
        vaultNamespace: policy("vault_namespace", ["vault enterprise"]),
        vaultAuth: policy("vault_auth", ["vault", "token", "approle", "authentication"]),
        vaultRoleId: policy("vault_role_id", ["approle", "vault"]),
        vaultAuthMount: policy("vault_auth_mount", ["approle", "vault"]),
        vaultCaBundle: policy("vault_ca_bundle", [...TLS_WORDS, "vault"]),
        hsmLibrary: policy("hsm_library", ["pkcs#11", "pkcs11", "softhsm", "module", "luna"]),
        hsmToken: policy("hsm_token", ["hsm", "slot", "partition"]),
        hsmKey: policy("hsm_key", ["hsm", "aes-256"]),
        kmsKey: policy("kms_key", ["aws", "kms", "arn", "cmk", "customer managed key"]),
        kmsRegion: policy("kms_region", ["aws", "kms"]),
        kmsEndpoint: policy("kms_endpoint", ["vpc endpoint", "privatelink", "aws"]),
        kmsFips: policy("kms_fips", ["fips 140", "compliance", "fedramp", "govcloud", "kms"]),
        rotate: onSection(
            setting(
                "Rotate master key",
                "Makes a new master key version and re-wraps every file's data key under it.",
                ["rotation", "rekey", "re-wrap"],
            ),
        ),
        encryptExisting: onSection(
            setting("Encrypt existing files", "Encrypts files written before encryption was on.", [
                "backfill",
                "migrate",
                "unencrypted",
            ]),
        ),
        checkFiles: onSection(
            setting(
                "Check every file",
                "Counts files under the current key, older keys or none, and finds unreadable ones.",
                ["verify", "scan", "integrity"],
            ),
        ),
    }),
};

export const ACCOUNTS = {
    people: section(
        "People",
        {
            invite: onSection(
                setting(
                    "Invite person",
                    "Adds someone who signs in with a password; they get a one-time link to set it.",
                    ["add user", "new user", "create account", "password link", "onboard"],
                ),
            ),
        },
        {
            description: "Everyone who can sign in, with their role and status.",
            keywords: [
                "users",
                "members",
                "accounts",
                "roles",
                "disable",
                "turn off",
                "deactivate",
                "reset password",
            ],
        },
    ),
    signIn: section("Sign-in and roles", {
        passwords: setting(
            "Passwords",
            "People an admin adds here sign in with a password they choose.",
            ["local accounts", "password"],
        ),
        sso: aka(
            ["sso", "oidc"],
            setting(
                "Single sign-on",
                "OpenID Connect with Entra, Okta, ADFS or Keycloak, set by auth.oidc in minibrain.yaml.",
                ["sso", "oidc", "openid", "entra", "azure ad", "okta", "keycloak", "idp"],
            ),
        ),
        proxy: aka(
            ["header auth"],
            setting(
                "Reverse proxy",
                "Signs people in from the user, email and groups headers of a trusted proxy.",
                ["header auth", "identity headers", "oauth2-proxy", "forward auth"],
            ),
        ),
        defaultRole: setting(
            "Role for people with no mapped group",
            "The role of people whose groups map to none; change it under Security.",
            ["default role", "sso", "groups"],
        ),
        groups: onSection(
            setting(
                "Group to role mapping",
                "Identity provider groups mapped to roles by auth.roles in minibrain.yaml.",
                ["groups", "rbac", "auth.roles", "ldap", "ad groups", "sso"],
            ),
        ),
    }),
};

export const AUDIT = {
    events: section("Audit events", {
        exportLog: pageTop(
            setting("Export audit log", "Downloads the filtered events as CSV or JSONL.", [
                "csv",
                "jsonl",
                "download",
                "compliance",
                "evidence",
            ]),
        ),
    }),
    integrity: section("Integrity", {
        hashChain: setting(
            "Hash chain",
            "Every event carries a SHA-256 hash of its fields and of the event before it.",
            ["tamper", "verify", "sha-256", "immutable", "worm"],
        ),
        siem: setting("SIEM export", "Whether your SIEM is keeping up with sealed events.", [
            "syslog",
            "forwarding",
            "splunk",
        ]),
    }),
    retention: section("Retention", {
        keep: policy("audit_retention_days", ["retention", "delete", "purge", "compliance"], {
            label: "Keep audit events",
            description: "Events older than this are deleted for good, checked every hour.",
        }),
    }),
};

export const DATA = {
    versionSize: section("Version size", {
        rowLimit: aka(
            ["row limit"],
            setting(
                "Most rows in one version",
                "A dataset version copies at most this many of its query's rows; a larger result is refused.",
                ["row limit", "max rows", "maximum rows", "size limit", "cap"],
            ),
        ),
    }),
    versionRetention: section("Version retention", {
        keepSnapshots: aka(
            ["snapshot retention"],
            setting(
                "Keep the last unused versions per dataset",
                "Older ones are removed with their files.",
                ["retention", "snapshots", "cleanup", "delete", "prune"],
            ),
        ),
    }),
    checks: section("Version checks", {
        duplicates: setting("Repeated inputs", "Rows whose input repeats an earlier one.", [
            "duplicates",
            "dedupe",
        ]),
        conflicts: setting("Conflicting labels", "The same input with different labels.", [
            "conflicts",
            "inconsistent",
        ]),
        balance: setting(
            "Label balance",
            "One label holding most rows, or labels with very few rows.",
            ["imbalance", "skew", "class balance"],
        ),
        leakage: setting(
            "Train and test overlap",
            "Test or held-out inputs that also appear in training.",
            ["leakage", "contamination"],
        ),
        length: setting(
            "Empty or long inputs",
            "Inputs left empty, or longer than a training example holds (estimated).",
            ["tokens", "truncation", "context length"],
        ),
        personalData: aka(
            ["pii"],
            setting(
                "Personal data",
                "Emails, phone numbers, card numbers and IBANs, found by pattern. It can miss names and addresses.",
                ["pii", "gdpr", "privacy", "email", "phone"],
            ),
        ),
        majorityShare: setting("Warn when one label holds more than", "Default 90%.", [
            "majority",
            "imbalance",
            "threshold",
        ]),
        minLabelRows: setting("Warn when a label has fewer rows than", "Default 10.", [
            "minimum rows",
            "rare labels",
            "threshold",
        ]),
    }),
};

const S3_WORDS = ["s3", "minio", "ceph", "object storage"];

export const STORAGE = {
    location: section("Where artifacts live", {
        kind: onSection(
            setting(
                "Storage location",
                "A local folder on this server, or an S3-compatible bucket, for uploads, dataset versions, adapters, logs and base model files.",
                [...S3_WORDS, "bucket", "disk", "artifacts", "files", "weights"],
            ),
        ),
        endpoint: setting("Endpoint", "minibrain connects to this address only.", [
            ...S3_WORDS,
            "url",
        ]),
        bucket: setting("Bucket", "The bucket new artifacts go to.", S3_WORDS),
        prefix: setting("Prefix", "A folder inside the bucket.", [...S3_WORDS, "path"]),
        region: setting("Region", "Leave empty unless the store asks for one.", [
            ...S3_WORDS,
            "aws",
        ]),
        accessKey: setting("Access key", "The key ID minibrain signs requests with.", [
            ...S3_WORDS,
            "access key id",
            "credentials",
        ]),
        secret: setting("Secret key", "Kept on this server and never shown again.", [
            ...S3_WORDS,
            "secret access key",
            "password",
            "credentials",
        ]),
    }),
    models: section("Base model files", {
        copy: onSection(
            setting(
                "Copy model files to the bucket",
                "Base models still on main's disk get their main copy in the bucket; main keeps its folder as a working copy.",
                [...S3_WORDS, "weights", "migrate", "move", "working copy"],
            ),
        ),
    }),
};

export const CONNECTIONS = {
    connections: section(
        "Buckets and databases",
        {
            add: onSection(
                setting(
                    "Add connection",
                    "Adds a bucket or database with its endpoint and a write-only secret.",
                    ["new connection", "s3", "postgres", "mysql", "credentials"],
                ),
            ),
        },
        {
            description:
                "S3-compatible buckets, PostgreSQL and MySQL databases that data sources and model imports read from.",
            keywords: [
                "s3",
                "postgres",
                "postgresql",
                "mysql",
                "minio",
                "database",
                "bucket",
                "credentials",
                "connection string",
            ],
        },
    ),
    extensions: section(
        "DuckDB extensions",
        {},
        {
            description:
                "Extensions that S3, database, Iceberg and Delta Lake sources read through, installed from a folder or a mirror.",
            keywords: [
                "httpfs",
                "iceberg",
                "delta",
                "postgres_scanner",
                "mysql_scanner",
                "offline",
                "air-gapped",
            ],
        },
    ),
};

export const INSTALL = {
    diagnostics: section("Diagnostics", {
        download: pageTop(
            setting(
                "Download diagnostics",
                "A zip of versions, settings, policies and recent warnings for a support request, without secrets.",
                ["support", "debug", "bundle", "logs", "zip"],
            ),
        ),
    }),
    software: section("Software", {
        minibrain: setting("minibrain", "The version of minibrain running here.", [
            "version",
            "release",
            "upgrade",
        ]),
        build: setting("Build", "The commit this install was built from.", [
            "commit",
            "git",
            "sha",
        ]),
        python: setting("Python", "The Python version.", ["version"]),
        duckdb: setting("DuckDB", "The DuckDB version that reads data sources.", ["version"]),
        pytorch: setting("PyTorch", "The PyTorch version used for training.", [
            "torch",
            "cuda",
            "version",
        ]),
        transformers: setting("Transformers", "The Hugging Face Transformers version.", [
            "hugging face",
            "version",
        ]),
        os: setting("Operating system", "The server's operating system.", [
            "os",
            "linux",
            "macos",
            "platform",
        ]),
        arch: setting("Architecture", "The server's CPU architecture.", [
            "cpu",
            "arm64",
            "x86_64",
            "aarch64",
        ]),
    }),
    locations: section("Locations", {
        server: setting("Server", "The host name of this server.", ["hostname", "host", "machine"]),
        home: setting("Home folder", "Settings, secrets, the database and model files.", [
            "minibrain_home",
            "data directory",
            "install path",
            "path",
        ]),
        database: setting("Database", "The SQLite file or PostgreSQL address.", [
            "sqlite",
            "postgresql",
            "postgres",
            "db",
            "database path",
        ]),
        artifactStorage: setting(
            "Artifact storage",
            "The local folder or S3-compatible bucket artifacts are stored in.",
            ["s3", "bucket", "storage path"],
        ),
        storageEndpoint: setting("Storage endpoint", "The S3-compatible store's address.", [
            "s3",
            "url",
        ]),
        web: setting("Web UI", "Where the web interface is served from.", [
            "frontend",
            "static files",
            "build",
        ]),
    }),
    catalogue: section("Model catalogue", {
        version: setting("Catalogue version", "The snapshot of the model catalogue in use.", [
            "snapshot",
            "bundled",
        ]),
        entries: setting("Entries", "How many models the catalogue describes.", [
            "catalogue size",
            "models",
        ]),
        checked: setting("Checked for updates", "When the catalogue was last checked.", [
            "sync",
            "last sync",
        ]),
        verified: setting(
            "Model files verified",
            "The last hash check across the models on this install.",
            ["hash", "checksum", "integrity", "sha-256"],
        ),
    }),
    compute: section("Compute", {
        pools: setting("Pools", "How many compute pools there are.", ["gpu pools"]),
        machines: setting("Machines", "Machines and how many are online.", [
            "nodes",
            "servers",
            "gpus",
        ]),
        workers: setting("Workers online", "Processes that run training and evaluation jobs.", [
            "jobs",
            "training",
            "processes",
        ]),
        engines: setting("Engines online", "Model servers reporting in the last 30 seconds.", [
            "serving",
            "inference",
            "model servers",
            "sglang",
            "vllm",
        ]),
    }),
    network: section("Network", {
        outbound: setting(
            "Outbound access",
            "Whether this install may reach other hosts: off, an allowlist or open.",
            ["egress", "internet", "air-gapped", "offline", "firewall"],
        ),
        allowedHosts: setting("Allowed hosts", "The hosts minibrain may reach.", [
            "allowlist",
            "whitelist",
        ]),
        telemetry: aka(
            ["analytics"],
            setting(
                "Telemetry",
                "No usage data, crash reports or analytics go to the minibrain developers or any third party.",
                ["analytics", "tracking", "phone home", "privacy", "crash reports"],
            ),
        ),
    }),
    observability: section("Observability", {
        otel: setting(
            "OpenTelemetry export",
            "Traces and metrics of /v1 requests, jobs and workers, sent only to your collector.",
            ["otlp", "otel", "traces"],
        ),
        prometheus: aka(
            ["metrics"],
            setting("Prometheus", "Metrics on /metrics for your own scraper.", [
                "metrics",
                "/metrics",
                "scrape",
                "grafana",
            ]),
        ),
        logFormat: setting("Log format", "Text or JSON lines on standard output.", [
            "json logs",
            "structured logging",
            "stdout",
        ]),
    }),
};

const PAGES: [SettingsPath, Record<string, SettingsSection>][] = [
    ["/settings", GENERAL],
    ["/settings/security", SECURITY],
    ["/settings/accounts", ACCOUNTS],
    ["/settings/audit", AUDIT],
    ["/settings/data", DATA],
    ["/settings/storage", STORAGE],
    ["/settings/connections", CONNECTIONS],
    ["/settings/install", INSTALL],
];

function sectionEntries(path: SettingsPath, name: string, part: SettingsSection): IndexEntry[] {
    const shared = { path, sectionAnchor: part.anchor, section: part.title, role: part.role };
    const own: IndexEntry[] = part.description
        ? [
              {
                  ...shared,
                  key: `${path}:${name}`,
                  anchor: part.anchor,
                  section: "",
                  label: part.title,
                  description: part.description,
                  keywords: part.keywords,
              },
          ]
        : [];
    const rows = Object.entries(part.settings).map(([key, item]) => ({
        ...shared,
        ...item,
        key: `${path}:${name}.${key}`,
        keywords: [...item.keywords, ...part.keywords],
    }));
    return [...own, ...rows];
}

export const SETTINGS_INDEX: IndexEntry[] = PAGES.flatMap(([path, sections]) =>
    Object.entries(sections).flatMap(([name, part]) => sectionEntries(path, name, part)),
);

export function entryAt(path: string, anchor: string): IndexEntry | undefined {
    return SETTINGS_INDEX.find((entry) => entry.path === path && entry.anchor === anchor);
}
