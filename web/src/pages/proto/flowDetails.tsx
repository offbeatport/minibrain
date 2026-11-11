import {
    Button,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldGroup,
    Input,
    Link,
    NumberField,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { CopyButton } from "~/components/CopyButton";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { Clipped, ownerOf } from "./flowActivity";
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
    liveVersion,
    modelHref,
    newestFirst,
    pct,
    pendingFeedback,
    shortAgo,
    useFlowState,
    versionHref,
} from "./modelsFlowData";

type EditKind = "description" | "tags" | "instructions" | "rule" | "safety";

const SAFETY_MODELS = ["Llama Guard 3 1B", "Qwen3Guard 0.6B"];
const NONE = "none";

const SCHEMAS: Record<string, string[]> = {
    "invoice-extractor": ["vendor", "invoice_number", "issued", "due", "total"],
    "contract-reviewer": ["standard", "risky"],
};

const TASK_TYPES: Record<string, string> = {
    Classify: "Labels",
    Extract: "JSON",
    SQL: "Chat",
};

const GRADERS: Record<string, string> = {
    Classify: "Exact label match",
    Extract: "Field match, schema",
    SQL: "Result match · judge",
};

function Row({
    label,
    children,
    onEdit,
}: {
    label: string;
    children: ReactNode;
    onEdit?: () => void;
}) {
    return (
        <div className="flex h-6 items-center gap-3">
            <dt className="w-24 shrink-0 truncate text-sm text-muted-foreground">{label}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-1">{children}</dd>
            {onEdit && (
                <Button
                    variant="link"
                    className="h-auto shrink-0 p-0 text-sm"
                    aria-label={`Edit ${label.toLowerCase()}`}
                    onClick={onEdit}
                >
                    Edit
                </Button>
            )}
        </div>
    );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex min-w-0 flex-col gap-1">
            <h3 className="text-sm font-semibold">{title}</h3>
            <dl className="flex flex-col">{children}</dl>
        </section>
    );
}

function Mono({ value, label, shown }: { value: string; label: string; shown?: string }) {
    return (
        <>
            <Clipped text={shown ?? value} className="font-mono text-sm" />
            <span className="-my-1.5 shrink-0">
                <CopyButton value={value} label={label} />
            </span>
        </>
    );
}

function Peek({ label, children }: { label: string; children: ReactNode }) {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="link" className="h-auto shrink-0 p-0 text-sm">
                    {label}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
                {children}
            </PopoverContent>
        </Popover>
    );
}

function Muted({ children }: { children: ReactNode }) {
    return <span className="truncate text-muted-foreground">{children}</span>;
}

function TextLink({ href, text }: { href: string; text: string }) {
    return (
        <Link href={href} className="min-w-0 truncate text-primary hover:underline" title={text}>
            {text}
        </Link>
    );
}

function DetailsCard({ model, children }: { model: FlowModel; children: ReactNode }) {
    return (
        <section
            aria-label={`${model.name} details`}
            className="@container flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-panel"
        >
            <h2 className="text-base leading-tight font-semibold">Details</h2>
            <div className="grid gap-x-panel gap-y-4 @xl:grid-cols-2">{children}</div>
        </section>
    );
}

function EditDialog({
    model,
    kind,
    onClose,
}: {
    model: FlowModel;
    kind: EditKind | null;
    onClose: () => void;
}) {
    return (
        <Dialog open={kind !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                {kind && <EditBody model={model} kind={kind} onClose={onClose} />}
            </DialogContent>
        </Dialog>
    );
}

const EDIT_TITLES: Record<EditKind, string> = {
    description: "Description",
    tags: "Tags",
    instructions: "Instructions",
    rule: "Promotion rule",
    safety: "Safety model",
};

function EditBody({
    model,
    kind,
    onClose,
}: {
    model: FlowModel;
    kind: EditKind;
    onClose: () => void;
}) {
    const toast = useToast();
    const [text, setText] = useState(
        kind === "tags"
            ? model.tags.join(", ")
            : kind === "instructions"
              ? model.instructions
              : model.description,
    );
    const [floor, setFloor] = useState(Math.round(model.rule[0] * 100));
    const [safety, setSafety] = useState(model.safety ?? NONE);
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
            rule: { rule: [floor / 100, model.rule[1]] },
            safety: { safety: safety === NONE ? null : safety },
        };
        editModel(model.slug, edits[kind]);
        toast({ title: `${EDIT_TITLES[kind]} saved`, tone: "success" });
        onClose();
    };
    return (
        <>
            <DialogHeader>
                <DialogTitle>{`Edit ${EDIT_TITLES[kind].toLowerCase()}`}</DialogTitle>
                <DialogDescription>
                    {kind === "instructions" || kind === "rule"
                        ? "It applies to the next version you train and score; versions already trained keep theirs."
                        : `Shown on ${model.name}'s page and in the model card.`}
                </DialogDescription>
            </DialogHeader>
            <FieldGroup>
                {(kind === "description" || kind === "tags") && (
                    <Field
                        id="edit-text"
                        label={EDIT_TITLES[kind]}
                        hint={kind === "tags" ? "Separate tags with commas." : undefined}
                    >
                        <Input
                            id="edit-text"
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                        />
                    </Field>
                )}
                {kind === "instructions" && (
                    <Field id="edit-text" label="Instructions">
                        <Textarea
                            id="edit-text"
                            rows={6}
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                        />
                    </Field>
                )}
                {kind === "rule" && (
                    <Field
                        id="edit-floor"
                        label={`${model.metrics[0]} at least`}
                        hint="A version must also beat live before it is offered to make live."
                    >
                        <NumberField
                            id="edit-floor"
                            value={floor}
                            onValueChange={(value) => setFloor(value ?? floor)}
                            min={0}
                            max={100}
                            step={1}
                            unit="%"
                            format={{ maximumFractionDigits: 0 }}
                        />
                    </Field>
                )}
                {kind === "safety" && (
                    <Field
                        id="edit-safety"
                        label="Safety model"
                        hint="Checks each request and answer; flagged ones are refused."
                    >
                        <Select value={safety} onValueChange={(value) => setSafety(String(value))}>
                            <SelectTrigger id="edit-safety">
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
                    </Field>
                )}
            </FieldGroup>
            <DialogFooter>
                <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button onClick={save}>Save</Button>
            </DialogFooter>
        </>
    );
}

function LineageAndIntegrity({ model }: { model: FlowModel }) {
    const live = liveVersion(model);
    const owner = ownerOf(model.slug);
    const failed = model.versions.filter((version) => version.status === "failed").length;
    const liveSha = live ? fakeSha(`${model.slug}@${live.number}`) : null;
    const baseSha = fakeSha(model.base ?? model.slug);
    return (
        <Collapsible className="self-start">
            <CollapsibleTrigger className="h-6">Lineage and integrity</CollapsibleTrigger>
            <CollapsibleContent>
                <div className="flex flex-col gap-4 pt-2">
                    <Group title="Lineage">
                        <Row label="Duplicated">
                            <Clipped text={owner.duplicated ?? "No, created new"} />
                        </Row>
                        <Row label="Base switches">
                            <Clipped text={owner.switches ?? "None"} />
                        </Row>
                        <Row label="Versions">
                            <Link
                                href={modelHref(model.slug, "versions")}
                                className="text-primary tabular-nums hover:underline"
                            >
                                {`${model.versions.length}${failed > 0 ? ` · ${failed} failed` : ""}`}
                            </Link>
                        </Row>
                    </Group>
                    <Group title="Integrity">
                        <Row label="Live adapter">
                            {liveSha ? (
                                <Mono
                                    value={liveSha}
                                    shown={`${liveSha.slice(0, 12)}…`}
                                    label="Copy live adapter SHA-256"
                                />
                            ) : (
                                <Muted>None</Muted>
                            )}
                        </Row>
                        <Row label="Base weights">
                            <Mono
                                value={baseSha}
                                shown={`${baseSha.slice(0, 12)}…`}
                                label="Copy base SHA-256"
                            />
                        </Row>
                        <Row label="Model card">
                            {live ? (
                                <TextLink
                                    href={cardHref(model.slug, live.number)}
                                    text={`v${live.number} card →`}
                                />
                            ) : (
                                <Muted>After a version is live</Muted>
                            )}
                        </Row>
                        <p className="pt-1 text-sm text-muted-foreground">
                            SHA-256, checked each time the weights load.
                        </p>
                    </Group>
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}

export function Details({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const can = useCan("builder");
    const [editing, setEditing] = useState<EditKind | null>(null);
    const edit = (kind: EditKind) => (can ? () => setEditing(kind) : undefined);
    const entry = model.base ? catalogEntry(baseModelSlug(model.base)) : undefined;
    const data = state.datasets.find((item) => item.slug === model.dataset);
    const live = liveVersion(model);
    const ordered = newestFirst(model);
    const oldest = ordered.at(-1);
    const pending = pendingFeedback(state, model.slug).length;
    const owner = ownerOf(model.slug);
    const labels =
        model.slug in SCHEMAS
            ? SCHEMAS[model.slug]
            : model.task === "Classify"
              ? (data?.labels.map(([label]) => label) ?? [])
              : [];
    const gguf = /gguf/i.test(model.base ?? "");
    const firstLine = model.instructions.split("\n")[0];
    const reasoning = /qwen/i.test(model.base ?? "");
    return (
        <DetailsCard model={model}>
            <Group title="About">
                <Row label="Description" onEdit={edit("description")}>
                    {model.description ? <Clipped text={model.description} /> : <Muted>None</Muted>}
                </Row>
                <Row label="Tags" onEdit={edit("tags")}>
                    {model.tags.length > 0 ? (
                        <Clipped text={model.tags.join(", ")} />
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
                <Row label="Created">
                    <Clipped
                        text={`${owner.by} · ${oldest ? shortAgo(oldest) : "just now"}`}
                        className="tabular-nums"
                    />
                </Row>
                <Row label="Updated">
                    <Clipped
                        text={ordered[0] ? shortAgo(ordered[0]) : "Never"}
                        className="tabular-nums"
                    />
                </Row>
            </Group>
            <Group title="Base">
                <Row label="Model">
                    <TextLink
                        href={modelHref(model.base ? baseModelSlug(model.base) : model.slug)}
                        text={gguf ? (model.base ?? "") : `${model.base} · BF16`}
                    />
                </Row>
                <Row label="Publisher">
                    <Clipped text={model.publisher} />
                </Row>
                <Row label="Size">
                    <Clipped
                        text={entry ? `${entry.params} params · ${entry.context} context` : "–"}
                        className="tabular-nums"
                    />
                </Row>
                <Row label="Licence">
                    <Clipped text={model.licence} />
                </Row>
                <Row label="Memory">
                    <Clipped
                        text={entry ? `${entry.memory} to serve` : "–"}
                        className="tabular-nums"
                    />
                </Row>
                <Row label="Training">
                    <Clipped text={model.serveOnly ? "Serve-only" : "LoRA, QLoRA"} />
                </Row>
            </Group>
            <Group title="Task">
                <Row label="Type">
                    <Clipped text={TASK_TYPES[model.task] ?? "Chat"} />
                </Row>
                <Row label={model.task === "Extract" ? "Schema" : "Labels"}>
                    {labels.length === 0 ? (
                        <Muted>Free text</Muted>
                    ) : (
                        <>
                            <span className="tabular-nums">
                                {model.task === "Extract"
                                    ? `${labels.length} fields`
                                    : `${labels.length} labels`}
                            </span>
                            <span aria-hidden="true" className="text-faint">
                                ·
                            </span>
                            <Peek label="View">
                                <ul className="flex flex-col gap-1 font-mono text-sm">
                                    {labels.map((label) => (
                                        <li key={label}>{label}</li>
                                    ))}
                                </ul>
                            </Peek>
                        </>
                    )}
                </Row>
                <Row label="Instructions" onEdit={edit("instructions")}>
                    {firstLine ? (
                        <>
                            <Clipped text={firstLine} />
                            <Peek label="View">
                                <p className="text-sm whitespace-pre-line">{model.instructions}</p>
                            </Peek>
                        </>
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
                <Row label="Graders">
                    <Clipped text={GRADERS[model.task] ?? "Judge"} />
                </Row>
                <Row label="Promotion" onEdit={edit("rule")}>
                    <Clipped
                        text={`≥ ${Math.round(model.rule[0] * 100)}%, beats live`}
                        className="tabular-nums"
                    />
                </Row>
            </Group>
            <Group title="Data">
                <Row label="Dataset">
                    {data ? (
                        <TextLink
                            href={datasetHref(data.slug)}
                            text={`${data.slug} v${data.version}`}
                        />
                    ) : (
                        <TextLink href={`${FLOW}/data?for=${model.slug}`} text="Add data" />
                    )}
                </Row>
                <Row label="Splits">
                    <Clipped
                        text={
                            data
                                ? `${count(data.split[0])} train · ${count(data.split[1])} held out`
                                : "–"
                        }
                        className="tabular-nums"
                    />
                </Row>
                <Row label="Feedback">
                    <Clipped
                        text={`${pending} to review · ${model.accepted} reviewed`}
                        className="tabular-nums"
                    />
                </Row>
                <Row label="Test examples">
                    <span className="tabular-nums">{count(24 + state.examples)}</span>
                </Row>
            </Group>
            <Group title="Serving">
                <Row label="Live">
                    {!model.deployed ? (
                        <StatusText tone="neutral">Not deployed</StatusText>
                    ) : live ? (
                        <TextLink
                            href={versionHref(model.slug, live.number)}
                            text={`v${live.number} · ${pct(live.scores?.[0])}`}
                        />
                    ) : (
                        <Muted>None</Muted>
                    )}
                </Row>
                <Row label="Replicas">
                    <Clipped
                        text={
                            model.replicas.length > 0
                                ? `${model.replicas.length} on ${model.replicas.join(", ")}`
                                : "None"
                        }
                    />
                </Row>
                <Row label="Safety" onEdit={edit("safety")}>
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
            </Group>
            <LineageAndIntegrity model={model} />
            <EditDialog model={model} kind={editing} onClose={() => setEditing(null)} />
        </DetailsCard>
    );
}

export function BaseDetails({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const entry = catalogEntry(model.slug);
    const children = state.models.filter(
        (item) => item.kind === "custom" && item.base && baseModelSlug(item.base) === model.slug,
    );
    const live = model.variants.filter((item) => item.live);
    const update = model.variants.find((item) => item.update);
    const variantsHref = modelHref(model.slug, "variants");
    return (
        <DetailsCard model={model}>
            <Group title="Base">
                <Row label="Publisher">
                    <Clipped text={entry?.publisher ?? model.publisher} />
                </Row>
                <Row label="Parameters">
                    <Clipped text={entry?.params ?? "–"} className="tabular-nums" />
                </Row>
                <Row label="Context">
                    <Clipped text={entry?.context ?? "–"} className="tabular-nums" />
                </Row>
                <Row label="Licence">
                    <Clipped text={entry?.licence ?? model.licence} />
                </Row>
                <Row label="Memory">
                    <Clipped
                        text={entry ? `${entry.memory} to serve` : "–"}
                        className="tabular-nums"
                    />
                </Row>
                <Row label="Training">
                    <Clipped
                        text={entry?.serveOnly || model.serveOnly ? "Serve-only" : "LoRA, QLoRA"}
                    />
                </Row>
                <Row label="Built on it">
                    {children.length === 0 ? (
                        <Muted>No custom models yet</Muted>
                    ) : (
                        <span className="min-w-0 truncate">
                            {children.map((child, index) => (
                                <span key={child.slug}>
                                    {index > 0 && ", "}
                                    <Link
                                        href={modelHref(child.slug)}
                                        className="text-primary hover:underline"
                                    >
                                        {child.name}
                                    </Link>
                                </span>
                            ))}
                        </span>
                    )}
                </Row>
            </Group>
            <Group title="Serving">
                <Row label="Deployed">
                    {live.length > 0 ? (
                        <StatusText tone="success">
                            {`${live.length} of ${model.variants.length} variants`}
                        </StatusText>
                    ) : (
                        <StatusText tone="neutral">Not deployed</StatusText>
                    )}
                </Row>
                <Row label="Variants">
                    <TextLink
                        href={variantsHref}
                        text={model.variants.map((item) => item.format).join(", ")}
                    />
                </Row>
                <Row label="Replicas">
                    <Clipped
                        text={
                            model.replicas.length > 0
                                ? `${model.replicas.length} on ${model.replicas.join(", ")}`
                                : "None"
                        }
                    />
                </Row>
                <Row label="gpu-a10-1">
                    <StatusText tone="success">Serves and trains</StatusText>
                </Row>
                <Row label="cpu-pool">
                    <Muted>Serves GGUF slowly; cannot train</Muted>
                </Row>
                <Row label="Updates">
                    {update ? (
                        <TextLink href={variantsHref} text={`${update.format} update available`} />
                    ) : (
                        <Muted>Up to date</Muted>
                    )}
                </Row>
            </Group>
        </DetailsCard>
    );
}
