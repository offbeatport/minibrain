import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
    Button,
    Checkbox,
    Field,
    InfoTip,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useEffect, useState } from "react";
import { type CatalogEntry, type CatalogVariantInfo, api, unwrap } from "~/api/client";
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

const FIT_TEXT: Record<string, string> = {
    fits: "Runs here",
    limited: "Tight fit",
    insufficient: "Needs more compute",
    unknown: "Fit not checked",
};

const SOURCE_HELP =
    "A Hugging Face model id or link (downloaded), an s3:// path, or an absolute folder path on the minibrain server (imported). Files must be in Hugging Face format: config.json, tokenizer files and .safetensors weights.";

export function looksLikeSource(text: string): boolean {
    return text.trim().includes("/");
}

export function VariantLicence({
    plan,
    accepted,
    onAccepted,
    onVariant,
}: {
    plan: SourcePlan;
    accepted: boolean;
    onAccepted: (accepted: boolean) => void;
    onVariant: (variant: string) => void;
}) {
    if (plan.target.kind !== "catalogue" || !plan.variant) {
        return null;
    }
    const { entry } = plan.target;
    return (
        <>
            {entry.variants.length > 1 && (
                <Field id="base-variant" label="Variant">
                    <Select
                        value={plan.variant.id}
                        onValueChange={(value) => onVariant(String(value ?? ""))}
                    >
                        <SelectTrigger id="base-variant" className="w-full sm:max-w-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {entry.variants.map((variant) => (
                                <SelectItem
                                    key={variant.id}
                                    value={variant.id}
                                    description={`${bytes(variant.size_bytes)} · ${FIT_TEXT[variant.fit.level] ?? ""}${variant.format === "gguf" ? " · serves only, cannot be fine-tuned" : ""}`}
                                >
                                    {variant.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
            )}
            {!plan.installedKey && plan.blocked && (
                <StatusText tone="warning" className="whitespace-normal">
                    {plan.blocked}
                </StatusText>
            )}
            {!plan.installedKey && !plan.blocked && (
                <Label className="flex items-start gap-2 font-normal">
                    <Checkbox
                        checked={accepted}
                        onCheckedChange={(value) => onAccepted(value === true)}
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
        </>
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
    | { kind: "import"; text: string };

export function ImportPanel({ seed, onUse }: { seed: string; onUse: (pick: ImportPick) => void }) {
    const [text, setText] = useState(looksLikeSource(seed) ? seed.trim() : "");
    const plan = useSourcePlan({ text, variant: "", accepted: false });
    const pick: ImportPick | null =
        plan.target.kind === "catalogue"
            ? { kind: "catalogue", entry: plan.target.entry }
            : plan.target.kind === "path" && plan.found?.ok
              ? { kind: "import", text: text.trim() }
              : null;
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5">
                    <label htmlFor="base-source" className="text-sm font-medium">
                        Hugging Face model, S3 path or folder
                    </label>
                    <InfoTip label="What can I add?">{SOURCE_HELP}</InfoTip>
                </span>
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
            <PathResult plan={plan} />
            <div>
                <Button type="button" disabled={!pick} onClick={() => pick && onUse(pick)}>
                    {pick?.kind === "import" ? "Import this model" : "Use this model"}
                </Button>
            </div>
        </div>
    );
}
