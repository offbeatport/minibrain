import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import {
    Button,
    InfoTip,
    Input,
    Link,
    ProviderLogo,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useEffect, useRef, useState } from "react";
import { type CatalogEntry, type CatalogVariantInfo, api, unwrap } from "~/api/client";
import { useConnections } from "~/api/connectionQueries";
import { keys, useCatalog } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import { GroupIcon } from "../data/icons";
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
    checks?: { label: string; ok: boolean; detail?: string | null }[];
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
        queryKey: ["all-models", "inspect", path, connection],
        queryFn: () =>
            unwrap(
                api.POST("/api/base-models/inspect", {
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
                    api.POST("/api/base-models/import", {
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
                added.variant_id === variant.id && added.availability.state !== "not_downloaded",
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

const SOURCES = [
    {
        title: "Hugging Face model",
        body: "Downloaded at a fixed revision. Hugging Face must be allowed under Model sources in Security.",
    },
    {
        title: "S3 path",
        body: "Copied in with the S3 connection for that bucket, or the one you pick. The bucket is left as it was.",
    },
    {
        title: "Folder on the minibrain server",
        body: "A folder on the machine running minibrain, not on this computer. Copied in; the original is left as it was.",
    },
];

function SourcesHelp() {
    return (
        <div className="flex flex-col gap-2.5 p-1.5 text-left text-pretty">
            <dl className="flex flex-col gap-2">
                {SOURCES.map((source) => (
                    <div key={source.title} className="flex flex-col gap-0.5">
                        <dt className="font-medium">{source.title}</dt>
                        <dd className="opacity-75">{source.body}</dd>
                    </div>
                ))}
            </dl>
            <p className="opacity-75">
                Files must be in Hugging Face format: config.json, tokenizer files and .safetensors
                weights. Quantized weights, such as GGUF or FP8, serve but can't be fine-tuned.
                Every file gets a SHA-256 record, so the model can be verified and repaired later.
            </p>
        </div>
    );
}

type SourceKind = "hub" | "s3" | "folder";

const KINDS: { kind: SourceKind; title: string; example: string; start: string; hint: string }[] = [
    {
        kind: "hub",
        title: "Hugging Face",
        example: "Qwen/Qwen3-1.7B",
        start: "",
        hint: "Qwen/Qwen3-1.7B or a huggingface.co link",
    },
    {
        kind: "s3",
        title: "S3 bucket",
        example: "s3://bucket/models/qwen3",
        start: "s3://",
        hint: "s3://bucket/models/qwen3",
    },
    {
        kind: "folder",
        title: "Folder on the server",
        example: "/srv/models/qwen3",
        start: "/",
        hint: "/srv/models/qwen3",
    },
];

function kindOf(text: string, target: SourcePlan["target"]): SourceKind | null {
    if (target.kind === "catalogue" || target.kind === "hub") {
        return "hub";
    }
    if (target.kind === "path") {
        return text.trim().startsWith("s3://") ? "s3" : "folder";
    }
    return null;
}

function KindIcon({ kind, className }: { kind: SourceKind; className?: string }) {
    if (kind === "hub") {
        return <ProviderLogo id="huggingface" className={className} />;
    }
    return <GroupIcon group={kind} className={className} />;
}

function KindCards({
    active,
    onChoose,
}: {
    active: SourceKind | null;
    onChoose: (kind: (typeof KINDS)[number]) => void;
}) {
    return (
        <div className="grid gap-2 sm:grid-cols-3">
            {KINDS.map((item) => (
                <button
                    key={item.kind}
                    type="button"
                    aria-pressed={item.kind === active}
                    onClick={() => onChoose(item)}
                    className="flex min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-accent"
                >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                        <KindIcon kind={item.kind} className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                        <span className="font-medium">{item.title}</span>
                        <span className="truncate font-mono text-muted-foreground">
                            {item.example}
                        </span>
                    </span>
                </button>
            ))}
        </div>
    );
}

export function looksLikeSource(text: string): boolean {
    return text.trim().includes("/");
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
        <div className="flex flex-col gap-2 rounded-md border px-3 py-3">
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

function Checklist({ checks }: { checks: NonNullable<Inspection["checks"]> }) {
    return (
        <ul className="flex flex-col gap-1.5 px-3 py-2.5">
            {checks.map((check) => (
                <li key={check.label} className="flex items-start gap-2">
                    {check.ok ? (
                        <Check
                            aria-hidden="true"
                            className="mt-0.5 size-4 flex-none text-success"
                        />
                    ) : (
                        <X
                            aria-hidden="true"
                            className="mt-0.5 size-4 flex-none text-destructive"
                        />
                    )}
                    <span className="flex min-w-0 flex-col">
                        <span>
                            <span className="sr-only">{check.ok ? "Passed: " : "Failed: "}</span>
                            {check.label}
                        </span>
                        {check.detail && (
                            <span className="text-muted-foreground">{check.detail}</span>
                        )}
                    </span>
                </li>
            ))}
        </ul>
    );
}

export function PathResult({ plan }: { plan: SourcePlan }) {
    if (plan.target.kind !== "path" || plan.target.location.length < 2) {
        return null;
    }
    if (plan.checking || !plan.found) {
        return <span className="text-muted-foreground">Checking…</span>;
    }
    const { found } = plan;
    if (!found.checks?.length) {
        return (
            <StatusText tone="destructive" className="whitespace-normal">
                {found.problem ?? "Cannot read this path"}
            </StatusText>
        );
    }
    const where = found.source_type === "s3" ? "S3" : "Folder";
    const facts = [found.architecture, `${found.files} files`, bytes(found.size_bytes)].filter(
        Boolean,
    );
    return (
        <div className="flex flex-col divide-y rounded-md border">
            <div className="flex flex-col gap-0.5 px-3 py-2.5">
                <span className="font-semibold">{found.name || where}</span>
                <span className="text-muted-foreground tabular-nums">
                    {[where, ...facts].join(" · ")}
                </span>
            </div>
            <Checklist checks={found.checks} />
            {found.ok && (
                <span className="px-3 py-2.5 text-muted-foreground">
                    {found.match
                        ? `Matches ${found.match}; files are checked against its catalogue checksums.`
                        : "No catalogue match: it imports as not verified."}
                </span>
            )}
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
            <p className="text-muted-foreground">
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
            <label htmlFor="base-connection" className="font-medium">
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
    const [chosen, setChosen] = useState<SourceKind>("hub");
    const [connection, setConnection] = useState<number | null>(null);
    const field = useRef<HTMLInputElement>(null);
    const plan = useSourcePlan({ text, variant: "", accepted: false, connection });
    const detected = kindOf(text, plan.target);
    const active = detected ?? chosen;
    const hint = KINDS.find((item) => item.kind === active)?.hint ?? "";
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
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="-m-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-1">
                <KindCards
                    active={active}
                    onChoose={(item) => {
                        setChosen(item.kind);
                        setText(item.start);
                        field.current?.focus();
                    }}
                />
                <div className="flex flex-col gap-label">
                    <span className="flex items-center gap-1.5">
                        <label htmlFor="base-source" className="font-medium">
                            Model id, link, S3 path or folder
                        </label>
                        <InfoTip label="Where models can come from">
                            <SourcesHelp />
                        </InfoTip>
                    </span>
                    <div className="relative">
                        <KindIcon
                            kind={active}
                            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                        />
                        <Input
                            ref={field}
                            id="base-source"
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && pick) {
                                    event.preventDefault();
                                    onUse(pick);
                                }
                            }}
                            placeholder={hint}
                            className="pl-8 font-mono"
                        />
                    </div>
                </div>
                {plan.target.kind === "empty" && (
                    <div className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground">
                        <span className="font-medium text-foreground">
                            Paste where the model is
                        </span>
                        <span>
                            minibrain reads its files and checks them before anything is copied.
                        </span>
                    </div>
                )}
                {plan.target.kind === "catalogue" && (
                    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                        <PublisherLogo
                            publisher={plan.target.entry.provider}
                            name={plan.target.entry.name}
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-semibold">{plan.target.entry.name}</span>
                            <span className="truncate text-muted-foreground">
                                {`In the catalogue · ${plan.target.entry.params_b.toFixed(1)}B parameters · ${plan.target.entry.license_name}`}
                            </span>
                        </span>
                        <StatusText tone="success">Tested revision</StatusText>
                    </div>
                )}
                {plan.target.kind === "hub" && <HubResult repo={plan.target.repo} />}
                {text.trim().startsWith("s3://") && (
                    <ConnectionChoice
                        value={connection}
                        found={plan.found}
                        onChange={setConnection}
                    />
                )}
                <PathResult plan={plan} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <span className="text-sm text-muted-foreground">
                    {plan.target.kind === "catalogue"
                        ? "Downloads into this install; every file gets a SHA-256."
                        : "Copied into this install and checked file by file; the source stays as it was."}
                </span>
                <Button type="button" disabled={!pick} onClick={() => pick && onUse(pick)}>
                    {pick?.kind === "import" ? "Import this model" : "Use this model"}
                </Button>
            </div>
        </div>
    );
}
