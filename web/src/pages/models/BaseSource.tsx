import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    Badge,
    Button,
    Input,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useEffect, useState } from "react";
import { type CatalogEntry, type CatalogVariantInfo, api, unwrap } from "~/api/client";
import { useConnections } from "~/api/connectionQueries";
import { keys, useCatalog } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import { bestFit } from "./DiscoverFilters";

type Target =
    | { kind: "empty" }
    | { kind: "catalogue"; entry: CatalogEntry }
    | { kind: "hub"; repo: string }
    | { kind: "path"; location: string };

const HUB_LINK = /^(?:https?:\/\/)?(?:www\.)?huggingface\.co\/([^/\s?#]+\/[^/\s?#]+)/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export function classify(text: string, entries: CatalogEntry[]): Target {
    const value = text.trim();
    if (!value) {
        return { kind: "empty" };
    }
    const byId = entries.find((entry) => entry.id === value);
    if (byId) {
        return { kind: "catalogue", entry: byId };
    }
    const linked = HUB_LINK.exec(value)?.[1];
    const repo = linked ?? (REPO.test(value) && !value.startsWith("/") ? value : null);
    if (repo) {
        const entry = entries.find((item) => item.repo.toLowerCase() === repo.toLowerCase());
        return entry ? { kind: "catalogue", entry } : { kind: "hub", repo };
    }
    return { kind: "path", location: value };
}

function useDebounced(value: string, ms: number): string {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setSettled(value), ms);
        return () => window.clearTimeout(timer);
    }, [value, ms]);
    return settled;
}

type Inspection = {
    ok: boolean;
    problem?: string | null;
    source_type?: string | null;
    architecture?: string | null;
    files?: number;
    size_bytes?: number;
    match?: string | null;
    name?: string | null;
    variant_id?: string | null;
    connection_id?: number | null;
    connection?: string | null;
};

export type SourceState = {
    text: string;
    variant: string;
    accepted: boolean;
    connection?: number | null;
};

export type SourcePlan = {
    target: Target;
    variant?: CatalogVariantInfo;
    installedKey?: string;
    blocked?: string;
    found?: Inspection;
    checking: boolean;
    ready: boolean;
    name?: string;
    run: () => Promise<string>;
};

export function useSourcePlan(state: SourceState): SourcePlan {
    const catalog = useCatalog();
    const entries = catalog.data?.entries ?? [];
    const target = classify(state.text, entries);
    const location = target.kind === "path" ? target.location : "";
    const path = useDebounced(location, 400);
    const connection = path.startsWith("s3://") ? (state.connection ?? null) : null;
    const check = useQuery({
        queryKey: ["models", "inspect", path, connection],
        queryFn: () =>
            unwrap(
                api.POST("/api/models/inspect", {
                    body: { location: path, connection_id: connection },
                }),
            ),
        enabled: path.length > 1,
        staleTime: 10_000,
    });
    const found = target.kind === "path" && path === location ? check.data : undefined;
    if (target.kind === "path") {
        return {
            target,
            found,
            checking: check.isFetching || path !== location,
            ready: Boolean(found?.ok),
            name: found?.name ?? undefined,
            run: async () => {
                const imported = await unwrap(
                    api.POST("/api/models/import", {
                        body: {
                            name: found?.name || "Imported model",
                            location,
                            description: "",
                            tags: [],
                            variant_id: found?.variant_id ?? null,
                            connection_id: found?.connection_id ?? connection,
                        },
                    }),
                );
                return imported.key;
            },
        };
    }
    if (target.kind === "catalogue") {
        const { entry } = target;
        const variant = entry.variants.find((item) => item.id === state.variant) ?? bestFit(entry);
        const installed = entry.added.find(
            (added) =>
                added.variant_id === variant.id &&
                !["not_downloaded", "evicted"].includes(added.availability.state),
        );
        const data = catalog.data;
        const blocked = installed
            ? undefined
            : data?.downloads_allowed === false
              ? "The Model sources policy allows imported files only."
              : data?.online === false
                ? "Offline: downloads need a connection. Import the files instead."
                : entry.gated && !data?.token_configured
                  ? "This model is gated: get access from its publisher and set HF_TOKEN on the server first."
                  : undefined;
        return {
            target,
            variant,
            installedKey: installed?.key,
            blocked,
            checking: false,
            ready: Boolean(installed) || (!blocked && state.accepted),
            name: entry.name,
            run: async () => {
                if (installed) {
                    return installed.key;
                }
                const row = await unwrap(
                    api.POST("/api/catalog/{catalog_id}/download", {
                        params: { path: { catalog_id: entry.id } },
                        body: { variant: variant.id, accept_license: true },
                    }),
                );
                return row.key;
            },
        };
    }
    return {
        target,
        checking: false,
        ready: false,
        run: async () => {
            throw new Error("Choose a base model first");
        },
    };
}

export const FIT_TEXT: Record<string, string> = {
    fits: "Runs here",
    limited: "Tight fit",
    insufficient: "Needs more compute",
    unknown: "Fit not checked",
};

type SourceKind = "hub" | "s3" | "folder";

const SOURCE_KINDS: { kind: SourceKind; title: string; example: string; body: string }[] = [
    {
        kind: "hub",
        title: "Hugging Face model",
        example: "Qwen/Qwen3-1.7B or a huggingface.co link",
        body: "Looked up on Hugging Face and downloaded into this install at a fixed revision. Catalogue models use the tested revision. Hugging Face must be allowed under Model sources in Security.",
    },
    {
        kind: "s3",
        title: "S3 path",
        example: "s3://bucket/models/qwen3-1.7b",
        body: "Copied from your bucket into this install with an S3 connection from Settings, Connections: the one for that bucket, or the one picked here. The endpoint must be allowed by the network policy in Security. The bucket is left as it was.",
    },
    {
        kind: "folder",
        title: "Folder on the minibrain server",
        example: "/srv/models/qwen3-1.7b",
        body: "A folder on the machine running minibrain, not on this computer. It is checked, then copied into this install; the original folder is left as it was.",
    },
];

function sourceKindOf(text: string, target: SourcePlan["target"]): SourceKind | null {
    if (target.kind === "catalogue" || target.kind === "hub") {
        return "hub";
    }
    if (target.kind === "path") {
        return text.trim().startsWith("s3://") ? "s3" : "folder";
    }
    return null;
}

function SourceKinds({ active }: { active: SourceKind | null }) {
    return (
        <div className="flex flex-col gap-2">
            <ul className="flex flex-col divide-y rounded-md border">
                {SOURCE_KINDS.map((item) => (
                    <li
                        key={item.kind}
                        data-active={item.kind === active || undefined}
                        className="flex flex-col gap-0.5 border-l-2 border-l-transparent px-3 py-2.5 data-active:border-l-primary data-active:bg-accent/60"
                    >
                        <span className="flex items-center gap-2">
                            <span className="text-sm font-semibold">{item.title}</span>
                            {item.kind === active && <Badge variant="outline">Detected</Badge>}
                        </span>
                        <span className="font-mono text-sm text-muted-foreground">
                            {item.example}
                        </span>
                        <span className="text-sm">{item.body}</span>
                    </li>
                ))}
            </ul>
            <p className="text-sm text-muted-foreground">
                Every file gets a SHA-256 record, so the model can be verified and repaired later.
                Files must be in Hugging Face format: config.json, tokenizer files and .safetensors
                weights. GGUF files can be served but not fine-tuned.
            </p>
        </div>
    );
}

export function looksLikeSource(text: string): boolean {
    return text.trim().includes("/");
}

export function formatLabel(variant: CatalogVariantInfo): string {
    return variant.format === "gguf"
        ? `Compressed (${variant.label}) · serve only`
        : `Full precision (${variant.label}) · trainable`;
}

function HubResult({ repo }: { repo: string }) {
    const catalog = useCatalog();
    const client = useQueryClient();
    const lookup = useMutation({
        mutationFn: () => unwrap(api.POST("/api/catalog/hub", { body: { repo } })),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.catalog }),
    });
    if (!catalog.data?.hub_add_allowed) {
        return (
            <StatusText tone="warning" className="whitespace-normal">
                Not in the catalogue, and the Model sources policy allows catalogue models only.
            </StatusText>
        );
    }
    return (
        <div className="flex flex-col gap-2 rounded-md border px-3 py-3 text-sm">
            <span>{`${repo} is not in the catalogue. minibrain can read its details from Hugging Face and add it.`}</span>
            <div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => lookup.mutate()}
                    disabled={lookup.isPending}
                >
                    {lookup.isPending ? "Looking up…" : "Look it up"}
                </Button>
            </div>
            <ErrorLine error={lookup.error} />
        </div>
    );
}

export function PathResult({ plan }: { plan: SourcePlan }) {
    if (plan.target.kind !== "path" || plan.target.location.length < 2) {
        return null;
    }
    if (plan.checking || !plan.found) {
        return <span className="text-sm text-muted-foreground">Checking…</span>;
    }
    const { found } = plan;
    if (!found.ok) {
        return (
            <StatusText tone="destructive" className="whitespace-normal">
                {found.problem ?? "Cannot read this path"}
            </StatusText>
        );
    }
    const where = found.source_type === "s3" ? "S3" : "Folder";
    return (
        <div className="flex flex-col gap-0.5 text-sm">
            <StatusText tone="success" className="whitespace-normal">
                {`${where} · ${found.architecture || "unknown architecture"} · ${found.files} files · ${bytes(found.size_bytes)}`}
            </StatusText>
            <span className="text-muted-foreground">
                {found.match
                    ? `Matches ${found.match}; files are checked against its catalogue checksums.`
                    : "No catalogue match: it imports as not verified."}
            </span>
        </div>
    );
}

export type ImportPick =
    | { kind: "catalogue"; entry: CatalogEntry }
    | { kind: "import"; text: string; connection: number | null };

function ConnectionChoice({
    value,
    found,
    onChange,
}: {
    value: number | null;
    found: Inspection | undefined;
    onChange: (value: number | null) => void;
}) {
    const connections = useConnections();
    const options = (connections.data ?? []).filter((item) => item.kind === "s3");
    if (connections.data && options.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                {
                    "No S3 connections yet, so the server's environment credentials are used. Add one under "
                }
                <Link href="/settings/connections" className="text-primary hover:underline">
                    Settings, Connections
                </Link>
                .
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor="base-connection" className="text-sm font-medium">
                Connection
            </label>
            <Select
                value={value === null ? "auto" : String(value)}
                onValueChange={(next) => onChange(next === "auto" || !next ? null : Number(next))}
            >
                <SelectTrigger id="base-connection" className="w-full sm:max-w-sm">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="auto" description="The first S3 connection for this bucket">
                        Matching connection
                    </SelectItem>
                    {options.map((item) => (
                        <SelectItem
                            key={item.id}
                            value={String(item.id)}
                            description={item.summary}
                        >
                            {item.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
                {found?.connection
                    ? `Reads with ${found.connection}.`
                    : "No connection is for this bucket: pick one, or the server's environment credentials are used."}
            </span>
        </div>
    );
}

export function ImportPanel({ seed, onUse }: { seed: string; onUse: (pick: ImportPick) => void }) {
    const [text, setText] = useState(looksLikeSource(seed) ? seed.trim() : "");
    const [connection, setConnection] = useState<number | null>(null);
    const plan = useSourcePlan({ text, variant: "", accepted: false, connection });
    const pick: ImportPick | null =
        plan.target.kind === "catalogue"
            ? { kind: "catalogue", entry: plan.target.entry }
            : plan.target.kind === "path" && plan.found?.ok
              ? {
                    kind: "import",
                    text: text.trim(),
                    connection: plan.found.connection_id ?? connection,
                }
              : null;
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
                <label htmlFor="base-source" className="text-sm font-medium">
                    Hugging Face model, S3 path or folder
                </label>
                <Input
                    id="base-source"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && pick) {
                            event.preventDefault();
                            onUse(pick);
                        }
                    }}
                    placeholder="Qwen/Qwen3-1.7B, s3://bucket/models/x or /srv/models/x"
                    className="font-mono"
                />
            </div>
            {plan.target.kind === "catalogue" && (
                <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm">
                    <PublisherLogo
                        publisher={plan.target.entry.provider}
                        name={plan.target.entry.name}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-semibold">{plan.target.entry.name}</span>
                        <span className="truncate text-muted-foreground">
                            In the catalogue; it downloads from Hugging Face.
                        </span>
                    </span>
                </div>
            )}
            {plan.target.kind === "hub" && <HubResult repo={plan.target.repo} />}
            {text.trim().startsWith("s3://") && (
                <ConnectionChoice value={connection} found={plan.found} onChange={setConnection} />
            )}
            <PathResult plan={plan} />
            <div>
                <Button type="button" disabled={!pick} onClick={() => pick && onUse(pick)}>
                    {pick?.kind === "import" ? "Import this model" : "Use this model"}
                </Button>
            </div>
            <SourceKinds active={sourceKindOf(text, plan.target)} />
        </div>
    );
}
