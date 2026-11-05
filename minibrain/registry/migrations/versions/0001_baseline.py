import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None

TIMESTAMP = sa.DateTime(timezone=True)
GENESIS = "0" * 64
ACTIVE = sa.text("status IN ('queued', 'running')")


def upgrade() -> None:
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("prefix", sa.String(), nullable=False),
        sa.Column("digest", sa.String(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("last_used_at", TIMESTAMP, nullable=True),
        sa.Column("expires_at", TIMESTAMP, nullable=True),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("digest"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "artifacts",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("packing", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    chain = op.create_table(
        "audit_chain",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("hash", sa.String(), nullable=False),
        sa.Column("forwarded_seq", sa.BigInteger(), nullable=False),
        sa.Column("forwarded_at", TIMESTAMP, nullable=True),
        sa.Column("forward_error", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("at", TIMESTAMP, nullable=False),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("target", sa.String(), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=False),
        sa.Column("ip", sa.String(), nullable=True),
        sa.Column("seq", sa.BigInteger(), nullable=True),
        sa.Column("prev_hash", sa.String(), nullable=True),
        sa.Column("hash", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_audit_events_action", "audit_events", ["action"], unique=False)
    op.create_index("ix_audit_events_actor", "audit_events", ["actor"], unique=False)
    op.create_index("ix_audit_events_at", "audit_events", ["at"], unique=False)
    op.create_index("ix_audit_events_seq", "audit_events", ["seq"], unique=True)
    op.create_table(
        "catalog_models",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("repo", sa.String(), nullable=False),
        sa.Column("capabilities", sa.JSON(), nullable=False),
        sa.Column("license", sa.String(), nullable=False),
        sa.Column("license_name", sa.String(), nullable=False),
        sa.Column("license_summary", sa.String(), nullable=False),
        sa.Column("license_url", sa.String(), nullable=False),
        sa.Column("gated", sa.Boolean(), nullable=False),
        sa.Column("recommended", sa.Boolean(), nullable=False),
        sa.Column("recommendation", sa.String(), nullable=True),
        sa.Column("template_kwargs", sa.JSON(), nullable=False),
        sa.Column("stop_tokens", sa.JSON(), nullable=False),
        sa.Column("popularity", sa.Integer(), nullable=False),
        sa.Column("context_tokens", sa.Integer(), nullable=True),
        sa.Column("released", sa.String(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("synced_at", TIMESTAMP, nullable=True),
        sa.Column("family", sa.String(), nullable=False),
        sa.Column("generation", sa.String(), nullable=False),
        sa.Column("architecture", sa.String(), nullable=False),
        sa.Column("tier", sa.String(), nullable=False),
        sa.Column("params_b", sa.Double(), nullable=False),
        sa.Column("moe", sa.Boolean(), nullable=False),
        sa.Column("shape", sa.JSON(), nullable=True),
        sa.Column("superseded_by", sa.String(), nullable=True),
        sa.Column("origin", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "connections",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("secret", sa.String(), nullable=True),
        sa.Column("secret_ref", sa.JSON(), nullable=True),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("problem", sa.String(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "dataset_folders",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["dataset_folders.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "engine_replicas",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("node_id", sa.String(), nullable=False),
        sa.Column("pool", sa.String(), nullable=False),
        sa.Column("base_model", sa.String(), nullable=False),
        sa.Column("engine", sa.String(), nullable=False),
        sa.Column("url", sa.String(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("managed", sa.Boolean(), nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("seen_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_engine_replicas_base_model"), "engine_replicas", ["base_model"], unique=False)
    op.create_table(
        "gateways",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("host", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("version", sa.String(), nullable=False),
        sa.Column("routes", sa.JSON(), nullable=False),
        sa.Column("bases", sa.JSON(), nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("seen_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "judge_scores",
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("score", sa.Double(), nullable=False),
        sa.Column("judge", sa.String(), nullable=False),
        sa.Column("judge_version", sa.String(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "nodes",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("pool", sa.String(), nullable=False),
        sa.Column("host", sa.String(), nullable=False),
        sa.Column("roles", sa.JSON(), nullable=False),
        sa.Column("hardware", sa.JSON(), nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("seen_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_nodes_pool"), "nodes", ["pool"], unique=False)
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("subject", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=True),
        sa.Column("groups", sa.JSON(), nullable=False),
        sa.Column("disabled", sa.Boolean(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=True),
        sa.Column("reset_hash", sa.String(), nullable=True),
        sa.Column("reset_expires_at", TIMESTAMP, nullable=True),
        sa.Column("failed_sign_ins", sa.Integer(), nullable=False),
        sa.Column("locked_until", TIMESTAMP, nullable=True),
        sa.Column("last_sign_in_at", TIMESTAMP, nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source", "subject", name="uq_users_source_subject"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_users_email", "users", ["email"], unique=False)
    op.create_index("ix_users_reset_hash", "users", ["reset_hash"], unique=True)
    op.create_table(
        "workers",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("host", sa.String(), nullable=False),
        sa.Column("kinds", sa.JSON(), nullable=False),
        sa.Column("gpus", sa.Integer(), nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("seen_at", TIMESTAMP, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "catalog_variants",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("catalog_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("format", sa.String(), nullable=False),
        sa.Column("precision", sa.String(), nullable=False),
        sa.Column("repo", sa.String(), nullable=False),
        sa.Column("revision", sa.String(), nullable=False),
        sa.Column("files", sa.JSON(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("weights_bytes", sa.BigInteger(), nullable=False),
        sa.Column("runtimes", sa.JSON(), nullable=False),
        sa.Column("requires", sa.JSON(), nullable=False),
        sa.Column("latest_revision", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["catalog_id"], ["catalog_models.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("last_seen_at", TIMESTAMP, nullable=False),
        sa.Column("expires_at", TIMESTAMP, nullable=False),
        sa.Column("ip", sa.String(), nullable=True),
        sa.Column("user_agent", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_sessions_user", "sessions", ["user_id"], unique=False)
    op.create_table(
        "sources",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("table_name", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=True),
        sa.Column("format", sa.String(), nullable=True),
        sa.Column("artifact_id", sa.String(), nullable=True),
        sa.Column("connection_id", sa.Integer(), nullable=True),
        sa.Column("query", sa.String(), nullable=True),
        sa.Column("change_column", sa.String(), nullable=True),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(
            ["artifact_id"],
            ["artifacts.id"],
        ),
        sa.ForeignKeyConstraint(
            ["connection_id"],
            ["connections.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("table_name"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "datasets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("source_id", sa.Integer(), nullable=True),
        sa.Column("folder_id", sa.Integer(), nullable=True),
        sa.Column("template", sa.JSON(), nullable=True),
        sa.Column("sql", sa.String(), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("dismissed", sa.JSON(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["folder_id"], ["dataset_folders.id"], name="fk_datasets_folder", ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["sources.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "models",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("catalog_id", sa.String(), nullable=True),
        sa.Column("variant_id", sa.String(), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("repo", sa.String(), nullable=True),
        sa.Column("revision", sa.String(), nullable=True),
        sa.Column("source_path", sa.String(), nullable=True),
        sa.Column("connection_id", sa.Integer(), nullable=True),
        sa.Column("files", sa.JSON(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("template_kwargs", sa.JSON(), nullable=False),
        sa.Column("stop_tokens", sa.JSON(), nullable=False),
        sa.Column("license", sa.String(), nullable=True),
        sa.Column("license_ack_by", sa.String(), nullable=True),
        sa.Column("license_ack_at", TIMESTAMP, nullable=True),
        sa.Column("deployed", sa.Boolean(), nullable=False),
        sa.Column("verified", sa.Boolean(), nullable=False),
        sa.Column("path", sa.String(), nullable=True),
        sa.Column("store", sa.String(), nullable=False),
        sa.Column("health", sa.String(), nullable=True),
        sa.Column("health_detail", sa.JSON(), nullable=False),
        sa.Column("verified_at", TIMESTAMP, nullable=True),
        sa.Column("last_used_at", TIMESTAMP, nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["catalog_id"], ["catalog_models.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["connection_id"], ["connections.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["variant_id"], ["catalog_variants.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "dataset_sources",
        sa.Column("dataset_id", sa.Integer(), nullable=False),
        sa.Column("source_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["sources.id"],
        ),
        sa.PrimaryKeyConstraint("dataset_id", "source_id"),
    )
    op.create_table(
        "minibrains",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("preset", sa.String(), nullable=False),
        sa.Column("base_model", sa.String(), nullable=False),
        sa.Column("contract", sa.JSON(), nullable=False),
        sa.Column("breaking_confirmed", sa.Boolean(), nullable=False),
        sa.Column("instructions", sa.String(), nullable=True),
        sa.Column("graders", sa.JSON(), nullable=False),
        sa.Column("promotion", sa.JSON(), nullable=False),
        sa.Column("dataset_id", sa.Integer(), nullable=True),
        sa.Column("current_version", sa.Integer(), nullable=True),
        sa.Column("deployed", sa.Boolean(), nullable=False),
        sa.Column("last_version", sa.Integer(), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("request_bodies", sa.Boolean(), nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("dataset_id", sa.Integer(), nullable=True),
        sa.Column("number", sa.Integer(), nullable=True),
        sa.Column("base_id", sa.Integer(), nullable=True),
        sa.Column("hash", sa.String(), nullable=False),
        sa.Column("artifact_id", sa.String(), nullable=False),
        sa.Column("counts", sa.JSON(), nullable=False),
        sa.Column("labels", sa.JSON(), nullable=False),
        sa.Column("rows", sa.Integer(), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("fingerprints", sa.JSON(), nullable=True),
        sa.Column("sql", sa.String(), nullable=True),
        sa.Column("saved", sa.Boolean(), nullable=False),
        sa.Column("checks", sa.JSON(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("taken_at", TIMESTAMP, nullable=True),
        sa.Column("feedback_rows", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["artifact_id"],
            ["artifacts.id"],
        ),
        sa.ForeignKeyConstraint(["base_id"], ["snapshots.id"], name="fk_snapshots_base", ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_snapshots_dataset_hash", "snapshots", ["dataset_id", "hash"], unique=False)
    op.create_index("uq_snapshots_dataset_number", "snapshots", ["dataset_id", "number"], unique=True)
    op.create_table(
        "api_key_scopes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("key_id", sa.Integer(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=True),
        sa.Column("model_id", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["key_id"], ["api_keys.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["model_id"], ["models.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key_id", "minibrain_id", "model_id"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "feedback",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("response_id", sa.String(), nullable=True),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("key_id", sa.Integer(), nullable=True),
        sa.Column("rating", sa.String(), nullable=False),
        sa.Column("input", sa.String(), nullable=False),
        sa.Column("input_key", sa.String(), nullable=False),
        sa.Column("output", sa.String(), nullable=True),
        sa.Column("correction", sa.String(), nullable=True),
        sa.Column("comment", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("assignee", sa.String(), nullable=True),
        sa.Column("reviewed_by", sa.String(), nullable=True),
        sa.Column("reviewed_at", TIMESTAMP, nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["key_id"], ["api_keys.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_feedback_input", "feedback", ["minibrain_id", "input_key"], unique=False)
    op.create_index("ix_feedback_queue", "feedback", ["priority", "id"], unique=False)
    op.create_index("ix_feedback_response", "feedback", ["response_id"], unique=False)
    op.create_table(
        "request_logs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("at", TIMESTAMP, nullable=False),
        sa.Column("key_id", sa.Integer(), nullable=True),
        sa.Column("minibrain_id", sa.Integer(), nullable=True),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("contract", sa.Integer(), nullable=True),
        sa.Column("status", sa.Integer(), nullable=False),
        sa.Column("latency_ms", sa.Double(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.Column("response_id", sa.String(), nullable=True),
        sa.Column("input", sa.String(), nullable=True),
        sa.Column("output", sa.String(), nullable=True),
        sa.Column("finish_reason", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["key_id"], ["api_keys.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_request_logs_at", "request_logs", ["at"], unique=False)
    op.create_index("ix_request_logs_key", "request_logs", ["key_id", "id"], unique=False)
    op.create_index("ix_request_logs_minibrain", "request_logs", ["minibrain_id", "id"], unique=False)
    op.create_index("ix_request_logs_response", "request_logs", ["response_id"], unique=False)
    op.create_table(
        "teardowns",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=True),
        sa.Column("model_id", sa.String(), nullable=True),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("step", sa.String(), nullable=False),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["model_id"], ["models.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["parent_id"], ["teardowns.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("minibrain_id"),
        sa.UniqueConstraint("model_id"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "versions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=True),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("contract", sa.JSON(), nullable=False),
        sa.Column("contract_number", sa.Integer(), nullable=False),
        sa.Column("instructions", sa.String(), nullable=False),
        sa.Column("shots", sa.JSON(), nullable=False),
        sa.Column("graders", sa.JSON(), nullable=False),
        sa.Column("live_at", TIMESTAMP, nullable=True),
        sa.Column("adapter_artifact_id", sa.String(), nullable=True),
        sa.Column("base_hash", sa.String(), nullable=True),
        sa.Column("recipe", sa.JSON(), nullable=False),
        sa.Column("metrics", sa.JSON(), nullable=True),
        sa.Column("intended_use", sa.String(), nullable=True),
        sa.Column("known_limits", sa.String(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(
            ["adapter_artifact_id"],
            ["artifacts.id"],
        ),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["snapshot_id"],
            ["snapshots.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("minibrain_id", "number"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("minibrain_id", sa.Integer(), nullable=True),
        sa.Column("version_id", sa.Integer(), nullable=True),
        sa.Column("model_id", sa.String(), nullable=True),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("needs_gpu", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("run_after", TIMESTAMP, nullable=False),
        sa.Column("lease_owner", sa.String(), nullable=True),
        sa.Column("lease_token", sa.String(), nullable=True),
        sa.Column("lease_expires_at", TIMESTAMP, nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False),
        sa.Column("idempotency_key", sa.String(), nullable=True),
        sa.Column("retry_of", sa.Integer(), nullable=True),
        sa.Column("progress", sa.Double(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("outputs", sa.JSON(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("error_code", sa.String(), nullable=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=True),
        sa.Column("finished_at", TIMESTAMP, nullable=True),
        sa.ForeignKeyConstraint(["minibrain_id"], ["minibrains.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["model_id"], ["models.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["retry_of"],
            ["jobs.id"],
        ),
        sa.ForeignKeyConstraint(["version_id"], ["versions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_jobs_claim", "jobs", ["status", "priority", "id"], unique=False)
    op.create_index("ix_jobs_kind", "jobs", ["kind", "id"], unique=False)
    op.create_index("ix_jobs_minibrain", "jobs", ["minibrain_id", "id"], unique=False)
    op.create_index(
        "uq_jobs_active_key",
        "jobs",
        ["idempotency_key"],
        unique=True,
        sqlite_where=ACTIVE,
        postgresql_where=ACTIVE,
    )
    op.create_table(
        "job_attempts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("worker", sa.String(), nullable=False),
        sa.Column("outcome", sa.String(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("retryable", sa.Boolean(), nullable=True),
        sa.Column("log_artifact_id", sa.String(), nullable=True),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("finished_at", TIMESTAMP, nullable=True),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["log_artifact_id"],
            ["artifacts.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "number"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "job_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("message", sa.String(), nullable=False),
        sa.Column("data", sa.JSON(), nullable=True),
        sa.Column("at", TIMESTAMP, nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sqlite_autoincrement=True,
    )
    op.create_index("ix_job_events_job", "job_events", ["job_id", "id"], unique=False)
    op.bulk_insert(chain, [{"id": 1, "seq": 0, "hash": GENESIS, "forwarded_seq": 0}])


def downgrade() -> None:
    op.drop_table("job_events")
    op.drop_table("job_attempts")
    op.drop_table("jobs")
    op.drop_table("versions")
    op.drop_table("teardowns")
    op.drop_table("request_logs")
    op.drop_table("feedback")
    op.drop_table("api_key_scopes")
    op.drop_table("snapshots")
    op.drop_table("minibrains")
    op.drop_table("dataset_sources")
    op.drop_table("models")
    op.drop_table("datasets")
    op.drop_table("sources")
    op.drop_table("sessions")
    op.drop_table("catalog_variants")
    op.drop_table("workers")
    op.drop_table("users")
    op.drop_table("nodes")
    op.drop_table("judge_scores")
    op.drop_table("gateways")
    op.drop_table("engine_replicas")
    op.drop_table("dataset_folders")
    op.drop_table("connections")
    op.drop_table("catalog_models")
    op.drop_table("audit_events")
    op.drop_table("audit_chain")
    op.drop_table("artifacts")
    op.drop_table("app_settings")
    op.drop_table("api_keys")
