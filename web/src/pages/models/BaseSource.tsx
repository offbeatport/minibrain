import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import {
    Button,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useEffect, useState } from "react";
import {
    type CatalogEntry,
    type CatalogVariantInfo,
    type ImportCheck,
    api,
    unwrap,
} from "~/api/client";
import { useConnections } from "~/api/connectionQueries";
import { keys, useCatalog } from "~/api/queries";
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

type Inspection = ImportCheck;

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

export function looksLikeSource(text: string): boolean {
    return text.trim().includes("/");
}

export function HubResult({ repo }: { repo: string }) {
    const client = useQueryClient();
    const lookup = useMutation({
        mutationFn: () => unwrap(api.POST("/api/catalog/hub", { body: { repo } })),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.catalog }),
    });
    return (
        <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
            <span>
                <span className="font-mono">{repo}</span>
                {
                    " is not in the catalogue. minibrain can read its details from Hugging Face and add it."
                }
            </span>
            <div>
                <Button
                    type="button"
                    variant="outline"
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

export function Checklist({ checks }: { checks: NonNullable<Inspection["checks"]> }) {
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
    | { kind: "catalogue"; entry: CatalogEntry; variant: string; accepted: boolean }
    | { kind: "import"; text: string; connection: number | null };

export function ConnectionChoice({
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
        <div className="flex flex-col gap-label">
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
