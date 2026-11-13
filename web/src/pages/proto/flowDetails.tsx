import { Info, Pencil, SlidersHorizontal } from "lucide-react";
import {
    Button,
    Input,
    Label,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { CopyButton } from "~/components/CopyButton";
import { PanelSection } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { ownerOf } from "./flowActivity";
import { Clipped } from "./flowClipped";
import { useCan } from "./flowOverlays";
import {
    FLOW,
    type FlowModel,
    type ModelEdit,
    baseModelSlug,
    cardHref,
    catalogEntry,
    datasetHref,
    duration,
    editModel,
    fakeSha,
    gradersOf,
    liveVersion,
    modelHref,
    newestFirst,
    pct,
    pendingFeedback,
    scoredBy,
    shortAgo,
    useFlowState,
    versionHref,
} from "./modelsFlowData";

type EditKind = "description" | "tags" | "instructions" | "safety";

const SAFETY_MODELS = ["Llama Guard 3 1B", "Qwen3Guard 0.6B"];
const NONE = "none";

const SCHEMAS: Record<string, string[]> = {
    "invoice-extractor": ["vendor", "invoice_number", "issued", "due", "total"],
    "contract-reviewer": ["standard", "risky"],
};

const LABEL_NOUNS: Record<string, string> = { "support-triage": "queues" };

const EDIT_TITLES: Record<EditKind, string> = {
    description: "Description",
    tags: "Tags",
    instructions: "Instructions",
    safety: "Safety model",
};

function apiNameOf(model: FlowModel): string {
    if (model.kind !== "base") {
        return model.slug;
    }
    return (model.variants.find((item) => item.live) ?? model.variants[0])?.apiName ?? model.slug;
}

function Muted({ children }: { children: ReactNode }) {
    return <span className="min-w-0 truncate text-muted-foreground">{children}</span>;
}

function Mono({ value, label }: { value: string; label: string }) {
    return (
        <>
            <Clipped text={value} className="font-mono text-sm" />
            <span className="-my-1 shrink-0">
                <CopyButton value={value} label={label} />
            </span>
        </>
    );
}

function Fact({
    label,
    children,
    edit,
    wide = false,
}: {
    label: string;
    children: ReactNode;
    edit?: ReactNode;
    wide?: boolean;
}) {
    return (
        <div className={cn("group/row flex min-w-0 flex-col gap-0.5", wide && "col-span-full")}>
            <dt className="truncate text-sm text-muted-foreground">{label}</dt>
            <dd className="flex h-6 min-w-0 items-center gap-1 tabular-nums">
                {children}
                {edit && <span className="-my-1 shrink-0">{edit}</span>}
            </dd>
        </div>
    );
}

function AboutSection({ children }: { children: ReactNode }) {
    return (
        <PanelSection
            icon={Info}
            title="About"
            description="What this model is and how to call it."
        >
            <div className="@container">
                <dl className="grid gap-x-4 gap-y-3 @md:grid-cols-2 @xl:grid-cols-3">{children}</dl>
            </div>
        </PanelSection>
    );
}

function EditForm({
    model,
    kind,
    onDone,
}: {
    model: FlowModel;
    kind: EditKind;
    onDone: () => void;
}) {
    const toast = useToast();
    const [text, setText] = useState(
        kind === "tags"
            ? model.tags.join(", ")
            : kind === "instructions"
              ? model.instructions
              : model.description,
    );
    const [safety, setSafety] = useState(model.safety ?? NONE);
    const id = `edit-${kind}`;
    const save = () => {
        const edits: Record<EditKind, ModelEdit> = {
            description: { description: text.trim() },
            tags: {
                tags: text
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
            },
            instructions: { instructions: text.trim() },
            safety: { safety: safety === NONE ? null : safety },
        };
        editModel(model.slug, edits[kind]);
        toast({ title: `${EDIT_TITLES[kind]} saved`, tone: "success" });
        onDone();
    };
    const hint =
        kind === "tags"
            ? "Separate tags with commas."
            : kind === "instructions"
              ? "Applies to the next version you train and score."
              : kind === "safety"
                ? "Checks each request and answer; flagged ones are refused."
                : null;
    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                save();
            }}
        >
            <div className="flex flex-col gap-label">
                <Label htmlFor={id}>{EDIT_TITLES[kind]}</Label>
                {(kind === "description" || kind === "tags") && (
                    <Input
                        id={id}
                        autoFocus
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                    />
                )}
                {kind === "instructions" && (
                    <Textarea
                        id={id}
                        autoFocus
                        rows={5}
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                    />
                )}
                {kind === "safety" && (
                    <Select value={safety} onValueChange={(value) => setSafety(String(value))}>
                        <SelectTrigger id={id}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={NONE} label="None">
                                None
                            </SelectItem>
                            {SAFETY_MODELS.map((item) => (
                                <SelectItem key={item} value={item} label={item}>
                                    {item}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
                {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
            </div>
            <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit">Save</Button>
            </div>
        </form>
    );
}

function EditPencil({ model, kind }: { model: FlowModel; kind: EditKind }) {
    const [open, setOpen] = useState(false);
    const label = `Edit ${EDIT_TITLES[kind].toLowerCase()}`;
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={label}
                            className="text-muted-foreground opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:text-foreground data-popup-open:opacity-100 [@media(hover:none)]:opacity-100"
                        >
                            <Pencil />
                        </Button>
                    </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-80">
                <EditForm model={model} kind={kind} onDone={() => setOpen(false)} />
            </PopoverContent>
        </Popover>
    );
}

function Row({
    label,
    children,
    edit,
}: {
    label: string;
    children: ReactNode;
    edit?: ReactNode;
}) {
    return (
        <div
            data-edit-row={edit ? "" : undefined}
            className="group/row flex h-7 items-center gap-3"
        >
            <dt className="w-32 shrink-0 truncate text-sm text-muted-foreground">{label}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-1 tabular-nums">
                {children}
                {edit}
            </dd>
        </div>
    );
}

function Group({
    title,
    caption,
    children,
}: {
    title: string;
    caption?: string;
    children: ReactNode;
}) {
    return (
        <section className="grid gap-x-panel px-panel py-3 @xl:grid-cols-[8rem_minmax(0,1fr)]">
            <div className="flex flex-col">
                <h3 className="text-base leading-7 font-medium">{title}</h3>
                {caption && <p className="pb-1 text-sm text-muted-foreground">{caption}</p>}
            </div>
            <dl className="flex min-w-0 flex-col">{children}</dl>
        </section>
    );
}

function DetailsSection({ description, children }: { description: string; children: ReactNode }) {
    return (
        <PanelSection icon={SlidersHorizontal} title="Details" description={description} flush>
            <div className="@container flex flex-col divide-y py-1">{children}</div>
        </PanelSection>
    );
}

function taskText(model: FlowModel, labels: string[]): string {
    if (model.task === "Extract") {
        return `JSON schema · ${labels.length} fields`;
    }
    if (model.task === "Classify") {
        return `Labels · ${labels.length} ${LABEL_NOUNS[model.slug] ?? "classes"}`;
    }
    return "Chat";
}

function labelsOf(model: FlowModel, labels: string[] | undefined): string[] {
    if (model.slug in SCHEMAS) {
        return SCHEMAS[model.slug];
    }
    return model.task === "Classify" ? (labels ?? []) : [];
}

function useModelLabels(model: FlowModel): string[] {
    const state = useFlowState();
    const data = state.datasets.find((item) => item.slug === model.dataset);
    return labelsOf(
        model,
        data?.labels.map(([label]) => label),
    );
}

function useEdit(model: FlowModel) {
    const can = useCan("builder");
    return (kind: EditKind) => (can ? <EditPencil model={model} kind={kind} /> : undefined);
}

export function About({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const edit = useEdit(model);
    const labels = useModelLabels(model);
    const data = state.datasets.find((item) => item.slug === model.dataset);
    const live = model.deployed ? liveVersion(model) : undefined;
    const gguf = /gguf/i.test(model.base ?? "");
    const replicas = model.replicas.length;
    const ordered = newestFirst(model);
    const oldest = ordered.at(-1);
    const owner = ownerOf(model.slug);
    return (
        <AboutSection>
            <Fact label="Task">
                <Clipped text={taskText(model, labels)} href={modelHref(model.slug, "training")} />
            </Fact>
            <Fact label="Deployed">
                {live ? (
                    <Clipped
                        text={`v${live.number} · ${pct(live.scores?.[0])} ${model.metrics[0].toLowerCase()}`}
                        href={versionHref(model.slug, live.number)}
                    />
                ) : (
                    <Muted>Not deployed</Muted>
                )}
            </Fact>
            <Fact label="Base">
                <Clipped
                    text={gguf ? (model.base ?? "") : `${model.base} · BF16`}
                    href={modelHref(model.base ? baseModelSlug(model.base) : model.slug)}
                />
            </Fact>
            <Fact label="Data">
                {data ? (
                    <Clipped
                        text={`${data.slug} v${data.version} · ${count(data.rows)} rows`}
                        href={datasetHref(data.slug)}
                    />
                ) : (
                    <Clipped text="Add data" href={`${FLOW}/data?for=${model.slug}`} />
                )}
            </Fact>
            <Fact label="Deployed">
                {model.deployed ? (
                    <Clipped
                        text={`${replicas} ${replicas === 1 ? "replica" : "replicas"}`}
                        href={modelHref(model.slug, "monitoring")}
                    />
                ) : (
                    <Muted>Not deployed</Muted>
                )}
            </Fact>
            <Fact label="API name">
                <Mono value={apiNameOf(model)} label="Copy API name" />
            </Fact>
            <Fact label="Tags" edit={edit("tags")}>
                {model.tags.length > 0 ? (
                    <Clipped text={model.tags.join(", ")} />
                ) : (
                    <Muted>None</Muted>
                )}
            </Fact>
            <Fact label="Created">
                <Clipped text={`${owner.by} · ${oldest ? shortAgo(oldest) : "just now"}`} />
            </Fact>
            <Fact label="Updated">
                <Clipped text={ordered[0] ? shortAgo(ordered[0]) : "Never"} />
            </Fact>
            <Fact label="Description" edit={edit("description")} wide>
                {model.description ? <Clipped text={model.description} /> : <Muted>None</Muted>}
            </Fact>
        </AboutSection>
    );
}

export function Details({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const edit = useEdit(model);
    const labels = useModelLabels(model);
    const data = state.datasets.find((item) => item.slug === model.dataset);
    const live = liveVersion(model);
    const pending = pendingFeedback(state, model.slug).length;
    const owner = ownerOf(model.slug);
    const failed = model.versions.filter((version) => version.status === "failed").length;
    const liveSha = live ? fakeSha(`${model.slug}@${live.number}`) : null;
    const reasoning = /qwen/i.test(model.base ?? "");
    const firstLine = model.instructions.split("\n")[0];
    return (
        <DetailsSection description="Task setup, data, serving, lineage and integrity.">
            <Group title="Task setup">
                <Row label={model.task === "Extract" ? "Fields" : "Labels"}>
                    {labels.length > 0 ? (
                        <Clipped text={labels.join(", ")} className="font-mono text-sm" />
                    ) : (
                        <Muted>Free text</Muted>
                    )}
                </Row>
                <Row label="Instructions" edit={edit("instructions")}>
                    {firstLine ? (
                        <Clipped text={model.instructions.replace(/\n/g, " ")} />
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
                <Row label="Graders">
                    <Clipped text={scoredBy(model)} />
                </Row>
                <Row label="Promotion rule">
                    <Clipped
                        text={`${gradersOf(model)[0]} ≥ ${Math.round(model.rule[0] * 100)}%, beats deployed`}
                    />
                </Row>
            </Group>
            <Group title="Data">
                <Row label="Splits">
                    {data ? (
                        <Clipped
                            text={`${count(data.split[0])} train · ${count(data.split[1])} held out`}
                        />
                    ) : (
                        <Muted>No data yet</Muted>
                    )}
                </Row>
                <Row label="Feedback waiting">
                    <Clipped
                        text={`${pending} to review · ${model.accepted} reviewed`}
                        href={`${FLOW}/feedback`}
                    />
                </Row>
                <Row label="Test examples">
                    <Clipped text={count(24 + state.examples)} />
                </Row>
            </Group>
            <Group title="Serving">
                <Row label="Safety" edit={edit("safety")}>
                    {model.safety ? <Clipped text={model.safety} /> : <Muted>None</Muted>}
                </Row>
                <Row label="Supports">
                    <Clipped text={reasoning ? "Tools, reasoning" : "Tools; no reasoning"} />
                </Row>
                <Row label="Autopilot">
                    <Clipped
                        text={
                            model.autopilot
                                ? model.autopilot.run
                                    ? `On · v${model.autopilot.run.version} canary, ${duration(model.autopilot.run.minutesLeft)} left`
                                    : "On"
                                : "Off"
                        }
                    />
                </Row>
                <Row label="Machines">
                    {model.replicas.length > 0 ? (
                        <Clipped text={model.replicas.join(", ")} className="font-mono text-sm" />
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
            </Group>
            <Group title="Lineage">
                <Row label="Created from">
                    <Clipped text={owner.duplicated ? `Copy of ${owner.duplicated}` : "New"} />
                </Row>
                <Row label="Base switches">
                    <Clipped text={owner.switches ?? "None"} />
                </Row>
                <Row label="Versions">
                    <Clipped
                        text={`${model.versions.length}${failed > 0 ? ` · ${failed} failed` : ""}`}
                        href={modelHref(model.slug, "versions")}
                    />
                </Row>
            </Group>
            <Group title="Integrity" caption="SHA-256, checked each time the weights load.">
                <Row label="Deployed adapter">
                    {liveSha ? (
                        <Mono value={liveSha} label="Copy deployed adapter SHA-256" />
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
                <Row label="Base weights">
                    <Mono value={fakeSha(model.base ?? model.slug)} label="Copy base SHA-256" />
                </Row>
                <Row label="Model card">
                    {live ? (
                        <Clipped
                            text={`v${live.number} card`}
                            href={cardHref(model.slug, live.number)}
                        />
                    ) : (
                        <Muted>After a version is deployed</Muted>
                    )}
                </Row>
            </Group>
        </DetailsSection>
    );
}

export function BaseAbout({ model }: { model: FlowModel }) {
    const entry = catalogEntry(model.slug);
    const live = model.variants.filter((item) => item.live);
    const description = model.description || entry?.summary;
    return (
        <AboutSection>
            <Fact label="Publisher">
                <Clipped text={entry?.publisher ?? model.publisher} />
            </Fact>
            <Fact label="Size">
                <Clipped text={entry ? `${entry.params} params · ${entry.context} context` : "–"} />
            </Fact>
            <Fact label="Licence">
                <Clipped text={entry?.licence ?? model.licence} />
            </Fact>
            <Fact label="Variants deployed">
                {live.length > 0 ? (
                    <Clipped
                        text={`${live.length} of ${model.variants.length} · ${live.map((item) => item.format).join(", ")}`}
                        href={modelHref(model.slug, "variants")}
                    />
                ) : (
                    <Muted>Not deployed</Muted>
                )}
            </Fact>
            <Fact label="Memory to serve">
                <Clipped text={entry?.memory ?? "–"} />
            </Fact>
            <Fact label="API name">
                <Mono value={apiNameOf(model)} label="Copy API name" />
            </Fact>
            <Fact label="Description" wide>
                {description ? <Clipped text={description} /> : <Muted>None</Muted>}
            </Fact>
        </AboutSection>
    );
}

export function BaseDetails({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const entry = catalogEntry(model.slug);
    const children = state.models.filter(
        (item) => item.kind === "custom" && item.base && baseModelSlug(item.base) === model.slug,
    );
    const update = model.variants.find((item) => item.update);
    const variantsHref = modelHref(model.slug, "variants");
    return (
        <DetailsSection
            description={
                children.length > 0 ? "Serving, lineage and integrity." : "Serving and integrity."
            }
        >
            <Group title="Serving">
                <Row label="Variants">
                    <Clipped
                        text={model.variants.map((item) => item.format).join(", ")}
                        href={variantsHref}
                    />
                </Row>
                <Row label="Machines">
                    {model.replicas.length > 0 ? (
                        <Clipped text={model.replicas.join(", ")} className="font-mono text-sm" />
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
                <Row label="gpu-a10-1">
                    <StatusText tone="success">Serves and trains</StatusText>
                </Row>
                <Row label="cpu-pool">
                    <Muted>Serves GGUF slowly; cannot train</Muted>
                </Row>
                <Row label="Training">
                    <Clipped
                        text={entry?.serveOnly || model.serveOnly ? "Serve-only" : "LoRA, QLoRA"}
                    />
                </Row>
                <Row label="Updates">
                    {update ? (
                        <Clipped text={`${update.format} update available`} href={variantsHref} />
                    ) : (
                        <Muted>Up to date</Muted>
                    )}
                </Row>
            </Group>
            {children.length > 0 && (
                <Group title="Lineage">
                    <Row label="Built on it">
                        <Clipped text={children.map((child) => child.name).join(", ")} />
                    </Row>
                </Group>
            )}
            <Group title="Integrity" caption="SHA-256, checked each time the weights load.">
                <Row label="Weights">
                    <Mono value={fakeSha(model.slug)} label="Copy weights SHA-256" />
                </Row>
            </Group>
        </DetailsSection>
    );
}
