import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Info } from "lucide-react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    SearchInput,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { useEffect, useState } from "react";
import { type CatalogEntry, type CatalogVariantInfo, api, unwrap } from "~/api/client";
import { keys, useCatalog } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { StatusText, type Tone } from "~/components/models/StatusText";
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
};

export type SourceState = { text: string; variant: string; accepted: boolean };

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
    const check = useQuery({
        queryKey: ["models", "inspect", path],
        queryFn: () => unwrap(api.POST("/api/models/inspect", { body: { location: path } })),
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

const FIT: Record<string, { text: string; tone: Tone }> = {
    fits: { text: "Fits this machine", tone: "success" },
    limited: { text: "Limited headroom", tone: "warning" },
    insufficient: { text: "Won't fit", tone: "destructive" },
    unknown: { text: "Fit not checked", tone: "neutral" },
};

const SOURCE_HELP =
    "A Hugging Face model id or link (downloaded), an s3:// path, or an absolute folder path on the minibrain server (imported). Files must be in Hugging Face format: config.json, tokenizer files and .safetensors weights.";

function CataloguePicker({
    open,
    onOpenChange,
    onPick,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onPick: (entry: CatalogEntry) => void;
}) {
    const catalog = useCatalog();
    const [query, setQuery] = useState("");
    const text = query.trim().toLowerCase();
    const entries = (catalog.data?.entries ?? []).filter((entry) =>
        `${entry.name} ${entry.provider} ${entry.repo}`.toLowerCase().includes(text),
    );
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Catalogue</DialogTitle>
                    <DialogDescription>
                        Models minibrain can download, with fit for this machine.
                    </DialogDescription>
                </DialogHeader>
                <SearchInput
                    aria-label="Search the catalogue"
                    placeholder="Search the catalogue"
                    value={query}
                    onValueChange={setQuery}
                />
                <ul className="flex flex-col divide-y rounded-md border">
                    {entries.map((entry) => {
                        const fit = FIT[bestFit(entry).fit.level];
                        return (
                            <li key={entry.id}>
                                <button
                                    type="button"
                                    onClick={() => onPick(entry)}
                                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none"
                                >
                                    <PublisherLogo
                                        publisher={entry.provider}
                                        name={entry.name}
                                        size="sm"
                                    />
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate font-semibold">{entry.name}</span>
                                        <span className="truncate text-sm text-muted-foreground">
                                            {`${entry.params_b.toFixed(1)}B · ${entry.license_name}`}
                                        </span>
                                    </span>
                                    {fit && <StatusText tone={fit.tone}>{fit.text}</StatusText>}
                                </button>
                            </li>
                        );
                    })}
                    {entries.length === 0 && (
                        <li className="px-3 py-4 text-sm text-muted-foreground">
                            No catalogue model matches.
                        </li>
                    )}
                </ul>
            </DialogContent>
        </Dialog>
    );
}

function CatalogueResult({
    plan,
    state,
    onState,
}: {
    plan: SourcePlan;
    state: SourceState;
    onState: (patch: Partial<SourceState>) => void;
}) {
    if (plan.target.kind !== "catalogue" || !plan.variant) {
        return null;
    }
    const { entry } = plan.target;
    const fit = FIT[plan.variant.fit.level];
    return (
        <div className="flex flex-col gap-3 rounded-md border bg-card px-3 py-3 text-sm">
            <div className="flex items-center gap-3">
                <PublisherLogo publisher={entry.provider} name={entry.name} />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-semibold">{entry.name}</span>
                    <span className="text-muted-foreground">
                        {`${entry.provider} · ${entry.params_b.toFixed(1)}B parameters · ${bytes(plan.variant.size_bytes)}`}
                    </span>
                </span>
                {fit && <StatusText tone={fit.tone}>{fit.text}</StatusText>}
            </div>
            {entry.variants.length > 1 && (
                <Select
                    value={plan.variant.id}
                    onValueChange={(value) => onState({ variant: String(value ?? "") })}
                >
                    <SelectTrigger aria-label="Variant" className="w-full max-w-sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {entry.variants.map((variant) => (
                            <SelectItem
                                key={variant.id}
                                value={variant.id}
                                description={`${bytes(variant.size_bytes)} · ${FIT[variant.fit.level]?.text ?? ""}${variant.format === "gguf" ? " · serves only" : ""}`}
                            >
                                {variant.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            {plan.installedKey ? (
                <StatusText tone="success">
                    Already on this install; nothing to download.
                </StatusText>
            ) : plan.blocked ? (
                <StatusText tone="warning">{plan.blocked}</StatusText>
            ) : (
                <Label className="flex items-start gap-2 font-normal">
                    <Checkbox
                        checked={state.accepted}
                        onCheckedChange={(value) => onState({ accepted: value === true })}
                        className="mt-px"
                    />
                    <span>
                        {`I accept the ${entry.license_name} for this install. `}
                        <a
                            href={entry.license_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                        >
                            Read it
                            <ExternalLink className="ml-0.5 inline size-3.5" />
                        </a>
                    </span>
                </Label>
            )}
        </div>
    );
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
            <StatusText tone="warning">
                Not in the catalogue, and the Model sources policy allows catalogue models only.
            </StatusText>
        );
    }
    return (
        <div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-3 text-sm">
            <span>{`${repo} is not in the catalogue. minibrain can read its details from Hugging Face.`}</span>
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

function PathResult({ plan }: { plan: SourcePlan }) {
    if (plan.target.kind !== "path" || plan.target.location.length < 2) {
        return null;
    }
    if (plan.checking || !plan.found) {
        return <span className="text-sm text-muted-foreground">Checking…</span>;
    }
    const { found } = plan;
    if (!found.ok) {
        return (
            <StatusText tone="destructive">{found.problem ?? "Cannot read this path"}</StatusText>
        );
    }
    const where = found.source_type === "s3" ? "S3" : "Folder";
    return (
        <div className="flex flex-col gap-0.5 rounded-md border bg-card px-3 py-2 text-sm">
            <StatusText tone="success">
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

export function SourceField({
    state,
    onState,
    plan,
}: {
    state: SourceState;
    onState: (patch: Partial<SourceState>) => void;
    plan: SourcePlan;
}) {
    const [picking, setPicking] = useState(false);
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5">
                    <label htmlFor="base-source" className="text-sm font-medium">
                        Hugging Face model, S3 path or folder
                    </label>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                aria-label="What can I add?"
                                className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            >
                                <Info className="size-4" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-80 whitespace-normal">
                            {SOURCE_HELP}
                        </TooltipContent>
                    </Tooltip>
                </span>
                <div className="flex flex-wrap gap-2">
                    <Input
                        id="base-source"
                        value={state.text}
                        onChange={(event) =>
                            onState({ text: event.target.value, variant: "", accepted: false })
                        }
                        placeholder="Qwen/Qwen3-1.7B, s3://bucket/models/x or /srv/models/x"
                        className="min-w-64 flex-1 font-mono"
                    />
                    <Button type="button" variant="outline" onClick={() => setPicking(true)}>
                        Browse the catalogue
                    </Button>
                </div>
            </div>
            <CatalogueResult plan={plan} state={state} onState={onState} />
            {plan.target.kind === "hub" && <HubResult repo={plan.target.repo} />}
            <PathResult plan={plan} />
            <CataloguePicker
                open={picking}
                onOpenChange={setPicking}
                onPick={(entry) => {
                    onState({ text: entry.repo, variant: "", accepted: false });
                    setPicking(false);
                }}
            />
        </div>
    );
}
