import { ArrowLeft, Check, Download } from "lucide-react";
import {
    Badge,
    Button,
    InfoTip,
    Input,
    Link,
    ProviderLogo,
    Tabs,
    TabsList,
    TabsTrigger,
    cn,
} from "obp-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
    CatalogEntry,
    CatalogResponse,
    FitInfo,
    ImportCheck,
    TrainFitInfo,
} from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { SECURITY_PATH } from "~/lib/requests";
import { bytes } from "~/lib/time";
import { GroupIcon } from "../data/icons";
import { Licence } from "./AddModelSummary";
import {
    Checklist,
    ConnectionChoice,
    HubResult,
    type ImportPick,
    type SourcePlan,
    classify,
    looksLikeSource,
    useSourcePlan,
} from "./BaseSource";
import { catalogueOption, gigabytes } from "./baseOptions";
import { formatName, trainable } from "./formats";

type SourceKind = "hub" | "s3" | "folder";

type KindInfo = {
    kind: SourceKind;
    title: string;
    label: string;
    start: string;
    placeholder: string;
    hint: string;
};

const KINDS: KindInfo[] = [
    {
        kind: "hub",
        title: "Hugging Face",
        label: "Model id or link",
        start: "",
        placeholder: "Qwen/Qwen3-1.7B",
        hint: "An id or a huggingface.co link. Downloaded at a fixed revision; every file gets a SHA-256.",
    },
    {
        kind: "s3",
        title: "S3 or bucket",
        label: "S3 path",
        start: "s3://",
        placeholder: "s3://bucket/models/qwen3",
        hint: "A folder of model files in a bucket. Copied in; the bucket is left as it was.",
    },
    {
        kind: "folder",
        title: "Server folder",
        label: "Folder on the server",
        start: "",
        placeholder: "/srv/models/qwen3",
        hint: "An absolute path on the machine running minibrain, not on this computer. Copied in; the original is left as it was.",
    },
];

const STARTS: Record<SourceKind, string> = { hub: "", s3: "s3://", folder: "" };

function kindInfo(kind: SourceKind): KindInfo {
    return KINDS.find((item) => item.kind === kind) ?? KINDS[0];
}

function detectKind(text: string): SourceKind | null {
    const value = text.trim();
    if (value.startsWith("s3://")) {
        return "s3";
    }
    if (value.startsWith("/") || value.startsWith("~")) {
        return "folder";
    }
    if (/huggingface\.co\//i.test(value) || /^[\w.-]+\/[\w.-]+$/.test(value)) {
        return "hub";
    }
    return null;
}

function KindIcon({ kind, className }: { kind: SourceKind; className?: string }) {
    if (kind === "hub") {
        return <ProviderLogo id="huggingface" className={className} />;
    }
    return <GroupIcon group={kind} className={className} />;
}

function FormatHelp() {
    return (
        <p className="p-1.5 text-left text-pretty">
            Files must be in Hugging Face format: config.json, tokenizer files and .safetensors
            weights. Quantized weights, such as FP8 or GPTQ, serve but can't be fine-tuned. Every
            file gets a SHA-256 record, so the model can be verified and repaired later.
        </p>
    );
}

function SourceChoice({
    kind,
    hubOff,
    onKind,
}: {
    kind: SourceKind;
    hubOff: string | null;
    onKind: (kind: SourceKind) => void;
}) {
    return (
        <div className="flex flex-col gap-label">
            <span className="flex items-center gap-1.5">
                <span id="import-source-label" className="font-medium">
                    Source
                </span>
                <InfoTip label="What can be imported">
                    <FormatHelp />
                </InfoTip>
            </span>
            <Tabs value={kind} onValueChange={(next) => onKind(next as SourceKind)}>
                <TabsList aria-labelledby="import-source-label" className="w-full sm:w-fit">
                    {KINDS.map((item) => (
                        <TabsTrigger
                            key={item.kind}
                            value={item.kind}
                            disabled={item.kind === "hub" && hubOff !== null}
                            className="px-2 sm:flex-none sm:px-3"
                        >
                            <KindIcon kind={item.kind} className="hidden size-4 sm:block" />
                            {item.title}
                        </TabsTrigger>
                    ))}
                </TabsList>
            </Tabs>
            {hubOff && (
                <p className="text-sm text-muted-foreground">{`Hugging Face is off: ${hubOff}`}</p>
            )}
        </div>
    );
}

function Fact({
    label,
    wide = false,
    children,
}: {
    label: string;
    wide?: boolean;
    children: ReactNode;
}) {
    return (
        <div
            className={cn(
                "flex min-w-0 flex-col gap-0.5 bg-card px-3 py-2",
                wide && "sm:col-span-2",
            )}
        >
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="min-w-0">{children}</dd>
        </div>
    );
}

const SERVE: Record<FitInfo["level"], { tone: Tone; text: string }> = {
    fits: { tone: "success", text: "Fits your compute" },
    limited: { tone: "success", text: "Fits your compute, with little room to spare" },
    insufficient: { tone: "warning", text: "Too large to serve on your compute" },
    unknown: { tone: "neutral", text: "Not checked: no machine has reported its memory yet" },
};

const TRAIN: Record<TrainFitInfo["level"], { tone: Tone; text: string }> = {
    fits: { tone: "success", text: "Trains on your compute" },
    insufficient: { tone: "warning", text: "Too large to train" },
    unknown: { tone: "neutral", text: "Training not checked: no trainer has reported yet" },
    unsupported: { tone: "neutral", text: "Serve only: quantized weights can't be fine-tuned" },
};

function Compute({ fit, train }: { fit?: FitInfo | null; train?: TrainFitInfo | null }) {
    if (!fit && !train) {
        return <span className="text-muted-foreground">Not checked</span>;
    }
    return (
        <span className="flex flex-col gap-1">
            {fit && (
                <StatusText tone={SERVE[fit.level].tone} className="whitespace-normal">
                    {SERVE[fit.level].text}
                </StatusText>
            )}
            {train && (
                <StatusText tone={TRAIN[train.level].tone} className="whitespace-normal">
                    {TRAIN[train.level].text}
                </StatusText>
            )}
        </span>
    );
}

function sizeText(value: number): string {
    return value >= 1024 ** 3 ? `${gigabytes(value)} GB` : bytes(value);
}

export function diskShort(size: number, free: number | null | undefined): boolean {
    return free !== null && free !== undefined && size > free;
}

function Disk({
    size,
    free,
    installed,
}: {
    size: number;
    free: number | null | undefined;
    installed?: boolean;
}) {
    if (installed) {
        return <StatusText tone="success">Already on this install</StatusText>;
    }
    const need = sizeText(size);
    if (free === null || free === undefined) {
        return <span className="tabular-nums">{`Needs ${need}`}</span>;
    }
    if (diskShort(size, free)) {
        return (
            <StatusText tone="destructive" className="whitespace-normal tabular-nums">
                {`Needs ${need}, only ${sizeText(free)} free`}
            </StatusText>
        );
    }
    return (
        <span className="tabular-nums">
            {`Needs ${need} `}
            <span className="text-muted-foreground">{`of ${sizeText(free)} free`}</span>
        </span>
    );
}

function Preview({
    logo,
    name,
    caption,
    serveOnly,
    children,
}: {
    logo: ReactNode;
    name: string;
    caption: ReactNode;
    serveOnly: boolean;
    children: ReactNode;
}) {
    return (
        <section aria-label="Preview" className="flex flex-col rounded-lg border bg-card">
            <header className="flex items-center gap-3 border-b px-3 py-2.5">
                {logo}
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-semibold">{name}</span>
                        {serveOnly && (
                            <Badge variant="warning" className="shrink-0">
                                Serve only
                            </Badge>
                        )}
                    </span>
                    <span className="truncate text-sm text-muted-foreground">{caption}</span>
                </span>
            </header>
            <dl className="grid gap-px overflow-hidden rounded-b-lg bg-border sm:grid-cols-2">
                {children}
            </dl>
        </section>
    );
}

function CataloguePreview({
    entry,
    plan,
    free,
    accepted,
    onAccepted,
}: {
    entry: CatalogEntry;
    plan: SourcePlan;
    free: number | null | undefined;
    accepted: boolean;
    onAccepted: (accepted: boolean) => void;
}) {
    const variant = plan.variant;
    if (!variant) {
        return null;
    }
    const option = catalogueOption(entry, variant.id);
    return (
        <Preview
            logo={<PublisherLogo publisher={entry.provider} name={entry.name} />}
            name={entry.name}
            caption={
                <>
                    {"In the catalogue · "}
                    <span className="font-mono">{variant.repo}</span>
                </>
            }
            serveOnly={!trainable(variant)}
        >
            <Fact label="Files">
                <span className="tabular-nums">{`${variant.files} files · ${sizeText(variant.size_bytes)}`}</span>
            </Fact>
            <Fact label="Format">{formatName(variant)}</Fact>
            <Fact label="Compute">
                <Compute fit={variant.fit} train={variant.train_fit} />
            </Fact>
            <Fact label="Disk">
                <Disk
                    size={variant.size_bytes}
                    free={free}
                    installed={Boolean(plan.installedKey)}
                />
            </Fact>
            <Fact label="Licence" wide>
                <Licence
                    id="import-licence"
                    option={option}
                    plan={plan}
                    accepted={accepted}
                    onAccepted={onAccepted}
                />
            </Fact>
        </Preview>
    );
}

function PathPreview({
    kind,
    found,
    free,
}: { kind: SourceKind; found: ImportCheck; free: number | null | undefined }) {
    const size = found.size_bytes ?? 0;
    return (
        <Preview
            logo={
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground">
                    <KindIcon kind={kind} className="size-4" />
                </span>
            }
            name={found.name || "Imported model"}
            caption={
                found.match
                    ? `Matches ${found.match}: checked against its catalogue checksums`
                    : "Not in the catalogue: imports as not verified"
            }
            serveOnly={Boolean(found.quantized)}
        >
            <Fact label="Files">
                <span className="tabular-nums">{`${found.files} files · ${sizeText(size)}`}</span>
            </Fact>
            <Fact label="Format">
                {found.quantized
                    ? `Quantized · ${found.quantized.toUpperCase()}`
                    : `Safetensors${found.architecture ? ` · ${found.architecture}` : ""}`}
            </Fact>
            <Fact label="Licence">
                {found.license ? (
                    <span className="font-mono">{found.license}</span>
                ) : (
                    <span className="text-muted-foreground">Not stated in its README</span>
                )}
            </Fact>
            <Fact label="Compute">
                <Compute fit={found.fit} train={found.train_fit} />
            </Fact>
            <Fact label="Disk">
                <Disk size={size} free={free} />
            </Fact>
            <Fact label="Checks">
                <span className="inline-flex items-center gap-1.5">
                    <Check aria-hidden="true" className="size-4 text-success" />
                    {`All ${found.checks?.length ?? 0} passed`}
                </span>
            </Fact>
        </Preview>
    );
}

type Problem = { title: string; detail?: string | null; action?: ReactNode };

function problemOf(kind: SourceKind, found: ImportCheck): Problem {
    const detail = found.problem;
    switch (found.problem_kind) {
        case "not_found":
            return {
                title: "Nothing found at this path",
                detail,
                action:
                    kind === "s3"
                        ? "Check the bucket name and prefix."
                        : "Check the spelling, and that the folder is on the minibrain server, not this computer.",
            };
        case "no_access":
            return {
                title: "No access",
                detail,
                action:
                    kind === "s3" ? (
                        <>
                            {"Pick a connection with read access, or add one in "}
                            <Link
                                href="/settings/connections"
                                className="text-primary hover:underline"
                            >
                                Settings, Connections
                            </Link>
                            .
                        </>
                    ) : (
                        "The minibrain server's user must be able to read this folder."
                    ),
            };
        case "policy":
            return {
                title: "Blocked by policy",
                detail,
                action: (
                    <>
                        {"An admin can change it in "}
                        <Link href={SECURITY_PATH} className="text-primary hover:underline">
                            Settings, Security
                        </Link>
                        .
                    </>
                ),
            };
        case "invalid":
            return {
                title: "Not a model minibrain can import",
                detail: found.checks?.length ? null : detail,
                action: found.checks?.length
                    ? "Point at a folder with config.json, tokenizer files and .safetensors weights."
                    : null,
            };
        default:
            return { title: "Couldn't read it", detail };
    }
}

function ProblemBox({ problem, children }: { problem: Problem; children?: ReactNode }) {
    return (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border px-3 py-2.5">
            <StatusText tone="destructive" className="font-medium whitespace-normal">
                {problem.title}
            </StatusText>
            {problem.detail && <p className="pl-3 break-words">{problem.detail}</p>}
            {children}
            {problem.action && <p className="pl-3 text-muted-foreground">{problem.action}</p>}
        </div>
    );
}

function Result({
    kind,
    plan,
    hubAdd,
    free,
    accepted,
    onAccepted,
}: {
    kind: SourceKind;
    plan: SourcePlan;
    hubAdd: boolean;
    free: number | null | undefined;
    accepted: boolean;
    onAccepted: (accepted: boolean) => void;
}) {
    const { target } = plan;
    if (target.kind === "catalogue") {
        if (plan.blocked) {
            return (
                <ProblemBox
                    problem={{
                        title: "Can't download it",
                        detail: plan.blocked,
                        action: "Copy its files to a server folder or a bucket and import them from there.",
                    }}
                />
            );
        }
        return (
            <CataloguePreview
                entry={target.entry}
                plan={plan}
                free={free}
                accepted={accepted}
                onAccepted={onAccepted}
            />
        );
    }
    if (target.kind === "hub") {
        return hubAdd ? (
            <HubResult repo={target.repo} />
        ) : (
            <ProblemBox
                problem={{
                    title: "Blocked by policy",
                    detail: `${target.repo} is not in the catalogue, and the Model sources policy allows catalogue models only.`,
                    action: (
                        <>
                            {
                                "Import its files from a server folder or a bucket, or ask an admin to change it in "
                            }
                            <Link href={SECURITY_PATH} className="text-primary hover:underline">
                                Settings, Security
                            </Link>
                            .
                        </>
                    ),
                }}
            />
        );
    }
    if (target.kind !== "path") {
        return null;
    }
    if (plan.checking || !plan.found) {
        return (
            <p aria-live="polite" className="text-muted-foreground">
                Reading the files…
            </p>
        );
    }
    const { found } = plan;
    if (!found.ok) {
        const failed = (found.checks ?? []).filter((check) => !check.ok);
        return (
            <ProblemBox problem={problemOf(kind, found)}>
                {failed.length > 0 && (
                    <div className="-mx-3">
                        <Checklist checks={failed} />
                    </div>
                )}
            </ProblemBox>
        );
    }
    return <PathPreview kind={kind} found={found} free={free} />;
}

function Prompt({ kind }: { kind: SourceKind }) {
    return (
        <div className="flex flex-col gap-1 rounded-lg border border-dashed px-3 py-3 text-muted-foreground">
            <span className="text-foreground">
                {kind === "hub" ? "Paste a model id or link" : "Paste where the model is"}
            </span>
            <span className="text-sm">
                minibrain reads its files and checks them before anything is copied: name, size,
                format, licence and whether it fits your compute show here.
            </span>
        </div>
    );
}

function planText(kind: SourceKind, text: string): string {
    const value = text.trim();
    if (value === STARTS[kind]) {
        return "";
    }
    if (kind === "folder" && value && !value.startsWith("/") && !value.startsWith("~")) {
        return "";
    }
    return value;
}

function seededKind(seed: string, hubOff: string | null): SourceKind {
    const found = looksLikeSource(seed) ? detectKind(seed) : null;
    if (found) {
        return found;
    }
    return hubOff ? "s3" : "hub";
}

export function ImportForm({
    seed,
    catalog,
    onUse,
    onBack,
    intro,
}: {
    seed: string;
    catalog: CatalogResponse | undefined;
    onUse: (pick: ImportPick) => void;
    onBack?: () => void;
    intro?: string;
}) {
    const hubOff =
        catalog?.downloads_allowed === false
            ? "the Model sources policy allows imported files only."
            : null;
    const [kind, setKind] = useState<SourceKind>(() => seededKind(seed, hubOff));
    const [texts, setTexts] = useState<Record<SourceKind, string>>(() => {
        const start = { ...STARTS };
        if (looksLikeSource(seed)) {
            start[seededKind(seed, hubOff)] = seed.trim();
        }
        return start;
    });
    const [connection, setConnection] = useState<number | null>(null);
    const [accepted, setAccepted] = useState(false);
    const field = useRef<HTMLInputElement>(null);
    const lastSeed = useRef(seed);
    useEffect(() => {
        if (seed === lastSeed.current) {
            return;
        }
        lastSeed.current = seed;
        const found = looksLikeSource(seed) ? detectKind(seed) : null;
        if (found) {
            setKind(found);
            setTexts((current) => ({ ...current, [found]: seed.trim() }));
        }
    }, [seed]);
    const text = texts[kind];
    const entries = catalog?.entries ?? [];
    const resolved = planText(kind, text);
    const target = classify(resolved, entries);
    const variant = target.kind === "catalogue" ? catalogueOption(target.entry).variant : null;
    const plan = useSourcePlan({
        text: resolved,
        variant: variant?.id ?? "",
        accepted,
        connection: kind === "s3" ? connection : null,
    });
    const free = catalog?.store_free_bytes;
    const info = kindInfo(kind);
    const relative = kind === "folder" && text.trim() !== "" && resolved === "";
    const size =
        plan.target.kind === "catalogue" && !plan.installedKey
            ? (plan.variant?.size_bytes ?? 0)
            : plan.target.kind === "path"
              ? (plan.found?.size_bytes ?? 0)
              : 0;
    const noRoom = diskShort(size, free);
    const licencePending =
        plan.target.kind === "catalogue" && !plan.installedKey && !plan.blocked && !accepted;
    const pick: ImportPick | null =
        plan.target.kind === "catalogue" && !plan.blocked && !licencePending
            ? {
                  kind: "catalogue",
                  entry: plan.target.entry,
                  variant: plan.variant?.id ?? "",
                  accepted: accepted || Boolean(plan.installedKey),
              }
            : plan.target.kind === "path" && plan.found?.ok
              ? {
                    kind: "import",
                    text: resolved,
                    connection: plan.found.connection_id ?? connection,
                }
              : null;
    const usable = pick && !noRoom ? pick : null;
    const use = () => usable && onUse(usable);
    const change = (value: string) => {
        const found = detectKind(value);
        const moved = found && found !== "hub" && found !== kind ? found : null;
        const next = moved ?? kind;
        setTexts((current) => ({ ...current, [next]: value }));
        if (moved) {
            setKind(moved);
        }
        setAccepted(false);
    };
    const failed = plan.target.kind === "path" && plan.found && !plan.found.ok && !plan.checking;
    const footnote = noRoom
        ? "Not enough disk space for this model."
        : failed || relative
          ? "Fix the problem above to import it."
          : licencePending
            ? "Accept the licence to continue."
            : plan.target.kind === "catalogue" || (plan.target.kind === "empty" && kind === "hub")
              ? "Downloads when you add the model; every file gets a SHA-256."
              : "Copied in when you add the model and checked file by file.";
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-field overflow-y-auto px-1 pt-1 pb-4">
                {intro && <p className="text-muted-foreground">{intro}</p>}
                <SourceChoice
                    kind={kind}
                    hubOff={hubOff}
                    onKind={(next) => {
                        setKind(next);
                        setAccepted(false);
                        window.requestAnimationFrame(() => field.current?.focus());
                    }}
                />
                <div className="flex flex-col gap-label">
                    <label htmlFor="import-location" className="font-medium">
                        {info.label}
                    </label>
                    <Input
                        ref={field}
                        id="import-location"
                        value={text}
                        onChange={(event) => change(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                use();
                            }
                        }}
                        placeholder={info.placeholder}
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={relative || undefined}
                        aria-describedby="import-location-hint"
                        className="font-mono"
                    />
                    <p id="import-location-hint" className="text-sm text-muted-foreground">
                        {relative ? (
                            <span className="text-destructive">
                                Use an absolute path on the server, such as /srv/models/qwen3.
                            </span>
                        ) : (
                            info.hint
                        )}
                    </p>
                </div>
                {kind === "s3" && (
                    <ConnectionChoice
                        value={connection}
                        found={plan.found}
                        onChange={setConnection}
                    />
                )}
                <div aria-live="polite" className="flex flex-col gap-3">
                    {noRoom && (
                        <ProblemBox
                            problem={{
                                title: "Not enough disk space",
                                detail: `It needs ${sizeText(size)} and ${sizeText(free ?? 0)} is free on the model files disk.`,
                                action: "Free up space there, or pick a smaller model.",
                            }}
                        />
                    )}
                    {plan.target.kind === "empty" ? (
                        relative ? null : (
                            <Prompt kind={kind} />
                        )
                    ) : (
                        <Result
                            kind={kind}
                            plan={plan}
                            hubAdd={Boolean(catalog?.hub_add_allowed)}
                            free={free}
                            accepted={accepted}
                            onAccepted={setAccepted}
                        />
                    )}
                </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3">
                <span className="text-sm text-muted-foreground">{footnote}</span>
                <span className="ml-auto flex items-center gap-2">
                    {onBack && (
                        <Button type="button" variant="ghost" onClick={onBack}>
                            <ArrowLeft />
                            Your imports
                        </Button>
                    )}
                    <Button type="button" disabled={!usable} onClick={use}>
                        <Download />
                        Import and use
                    </Button>
                </span>
            </div>
        </div>
    );
}
