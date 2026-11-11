import {
    Button,
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

type Owner = { by: string; duplicated: string | null; switches: string | null };

const OWNERS: Record<string, Owner> = {
    "support-triage": { by: "Dana Ilie", duplicated: null, switches: null },
    "invoice-extractor": { by: "Sam Okafor", duplicated: null, switches: null },
    "contract-reviewer": {
        by: "Sam Okafor",
        duplicated: "Support triage",
        switches: "1 · from Qwen3 0.6B",
    },
};

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
        <div className="flex min-h-7 items-center gap-3">
            <dt className="w-24 shrink-0 text-sm text-muted-foreground">{label}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-1 truncate">{children}</dd>
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
        <section className="flex flex-col gap-1.5 px-panel py-4">
            <h3 className="font-semibold">{title}</h3>
            <dl className="flex flex-col">{children}</dl>
        </section>
    );
}

function Mono({ value, label, shown }: { value: string; label: string; shown?: string }) {
    return (
        <>
            <span className="truncate font-mono text-sm" title={value}>
                {shown ?? value}
            </span>
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

function Truncated({ children }: { children: ReactNode }) {
    return <span className="min-w-0 truncate">{children}</span>;
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

export function FactSheet({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const can = useCan("builder");
    const [editing, setEditing] = useState<EditKind | null>(null);
    const edit = (kind: EditKind) => (can ? () => setEditing(kind) : undefined);
    const entry = model.base ? catalogEntry(baseModelSlug(model.base)) : undefined;
    const data = state.datasets.find((item) => item.slug === model.dataset);
    const live = liveVersion(model);
    const ordered = newestFirst(model);
    const oldest = ordered.at(-1);
    const failed = model.versions.filter((version) => version.status === "failed").length;
    const pending = pendingFeedback(state, model.slug).length;
    const owner = OWNERS[model.slug] ?? { by: "You", duplicated: null, switches: null };
    const labels =
        model.slug in SCHEMAS
            ? SCHEMAS[model.slug]
            : model.task === "Classify"
              ? (data?.labels.map(([label]) => label) ?? [])
              : [];
    const gguf = /gguf/i.test(model.base ?? "");
    const firstLine = model.instructions.split("\n")[0];
    const liveSha = live ? fakeSha(`${model.slug}@${live.number}`) : null;
    const baseSha = fakeSha(model.base ?? model.slug);
    const reasoning = /qwen/i.test(model.base ?? "");
    return (
        <aside
            aria-label={`${model.name} facts`}
            className="flex min-w-0 flex-col divide-y rounded-lg border bg-card"
        >
            <Group title="About">
                <Row label="API name">
                    <Mono value={model.slug} label="Copy API name" />
                </Row>
                <Row label="Description" onEdit={edit("description")}>
                    <Truncated>
                        {model.description || <span className="text-muted-foreground">None</span>}
                    </Truncated>
                </Row>
                <Row label="Tags" onEdit={edit("tags")}>
                    <Truncated>
                        {model.tags.length > 0 ? (
                            model.tags.join(", ")
                        ) : (
                            <span className="text-muted-foreground">None</span>
                        )}
                    </Truncated>
                </Row>
                <Row label="Created">
                    <Truncated>
                        {`${owner.by} · ${oldest ? shortAgo(oldest) : "just now"}`}
                    </Truncated>
                </Row>
                <Row label="Updated">
                    <Truncated>{ordered[0] ? shortAgo(ordered[0]) : "Never"}</Truncated>
                </Row>
            </Group>
            <Group title="Base">
                <Row label="Base">
                    <Link
                        href={modelHref(model.base ? baseModelSlug(model.base) : model.slug)}
                        className="truncate text-primary hover:underline"
                    >
                        {gguf ? model.base : `${model.base} · BF16`}
                    </Link>
                </Row>
                <Row label="Publisher">{model.publisher}</Row>
                <Row label="Parameters">
                    <span className="tabular-nums">{entry?.params ?? "–"}</span>
                </Row>
                <Row label="Context">
                    <span className="tabular-nums">{entry?.context ?? "–"}</span>
                </Row>
                <Row label="Licence">
                    <Truncated>{model.licence}</Truncated>
                </Row>
                <Row label="Memory">
                    <span className="tabular-nums">{entry ? `${entry.memory} to serve` : "–"}</span>
                </Row>
                <Row label="Training">
                    <Truncated>{model.serveOnly ? "Serve-only" : "LoRA, QLoRA"}</Truncated>
                </Row>
            </Group>
            <Group title="Task">
                <Row label="Type">{TASK_TYPES[model.task] ?? "Chat"}</Row>
                <Row label={model.task === "Extract" ? "Schema" : "Labels"}>
                    {labels.length === 0 ? (
                        <span className="text-muted-foreground">Free text</span>
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
                            <Truncated>{firstLine}</Truncated>
                            <Peek label="View">
                                <p className="text-sm whitespace-pre-line">{model.instructions}</p>
                            </Peek>
                        </>
                    ) : (
                        <span className="text-muted-foreground">None</span>
                    )}
                </Row>
                <Row label="Graders">
                    <Truncated>{GRADERS[model.task] ?? "Judge"}</Truncated>
                </Row>
                <Row label="Promotion" onEdit={edit("rule")}>
                    <Truncated>{`≥ ${Math.round(model.rule[0] * 100)}%, beats live`}</Truncated>
                </Row>
            </Group>
            <Group title="Data">
                <Row label="Dataset">
                    {data ? (
                        <Link
                            href={datasetHref(data.slug)}
                            className="truncate text-primary hover:underline"
                        >
                            {`${data.slug} v${data.version}`}
                        </Link>
                    ) : (
                        <Link
                            href={`${FLOW}/data?for=${model.slug}`}
                            className="text-primary hover:underline"
                        >
                            Add data
                        </Link>
                    )}
                </Row>
                <Row label="Splits">
                    <Truncated>
                        <span className="tabular-nums">
                            {data
                                ? `${count(data.split[0])} train · ${count(data.split[1])} held out`
                                : "–"}
                        </span>
                    </Truncated>
                </Row>
                <Row label="Feedback">
                    <Truncated>
                        <span className="tabular-nums">
                            {`${pending} to review · ${model.accepted} reviewed`}
                        </span>
                    </Truncated>
                </Row>
                <Row label="Test examples">
                    <span className="tabular-nums">{count(24 + state.examples)}</span>
                </Row>
            </Group>
            <Group title="Serving">
                <Row label="Deployed">
                    {model.deployed ? (
                        <StatusText tone="success">Deployed</StatusText>
                    ) : (
                        <StatusText tone="neutral">Not deployed</StatusText>
                    )}
                </Row>
                <Row label="Live version">
                    {live ? (
                        <Link
                            href={versionHref(model.slug, live.number)}
                            className="text-primary tabular-nums hover:underline"
                        >
                            {`v${live.number} · ${pct(live.scores?.[0])}`}
                        </Link>
                    ) : (
                        <span className="text-muted-foreground">None</span>
                    )}
                </Row>
                <Row label="Replicas">
                    <Truncated>
                        {model.replicas.length > 0
                            ? `${model.replicas.length} on ${model.replicas.join(", ")}`
                            : "None"}
                    </Truncated>
                </Row>
                <Row label="Safety" onEdit={edit("safety")}>
                    <Truncated>
                        {model.safety ?? <span className="text-muted-foreground">None</span>}
                    </Truncated>
                </Row>
                <Row label="Supports">
                    <Truncated>{reasoning ? "Tools, reasoning" : "Tools; no reasoning"}</Truncated>
                </Row>
                <Row label="Autopilot">
                    <Truncated>
                        {model.autopilot
                            ? model.autopilot.run
                                ? `On · v${model.autopilot.run.version} canary, ${duration(model.autopilot.run.minutesLeft)} left`
                                : "On"
                            : "Off"}
                    </Truncated>
                </Row>
            </Group>
            <Group title="Lineage">
                <Row label="Duplicated">
                    <Truncated>{owner.duplicated ?? "No, created new"}</Truncated>
                </Row>
                <Row label="Base switches">
                    <Truncated>{owner.switches ?? "None"}</Truncated>
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
                        <span className="text-muted-foreground">None</span>
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
                        <Link
                            href={cardHref(model.slug, live.number)}
                            className="text-primary hover:underline"
                        >
                            {`v${live.number} card →`}
                        </Link>
                    ) : (
                        <span className="text-muted-foreground">After a version is live</span>
                    )}
                </Row>
                <p className="pt-1 text-sm text-muted-foreground">
                    SHA-256, checked each time the weights load.
                </p>
            </Group>
            <EditDialog model={model} kind={editing} onClose={() => setEditing(null)} />
        </aside>
    );
}
