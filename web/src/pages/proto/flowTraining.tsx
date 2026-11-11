import { useRouter } from "@tanstack/react-router";
import { GraduationCap, RotateCcw, X } from "lucide-react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast,
} from "obp-ui";
import { type MouseEvent, type ReactNode, useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, PanelSection, PanelSections } from "~/components/Section";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import { openTrain, useCan } from "./flowOverlays";
import {
    type FlowModel,
    type Job,
    type JobStatus,
    cancelJobs,
    findVersion,
    jobHref,
    modelHref,
    nextNumber,
    pct,
    retryJobs,
    shortAgo,
    useFlowState,
    versionHref,
} from "./modelsFlowData";
import { ModelAvatar, Tip, VersionName } from "./modelsFlowParts";

export function trainBlock(model: FlowModel): string | null {
    if (model.serveOnly) {
        return `${model.base} is serve-only: GGUF weights cannot be trained.`;
    }
    if (!model.dataset) {
        return "Attach a dataset first: training needs examples.";
    }
    return null;
}

export function TrainButton({
    model,
    variant = "default",
    label,
}: {
    model: FlowModel;
    variant?: "default" | "outline";
    label?: string;
}) {
    const blocked = trainBlock(model);
    if (!useCan("builder")) {
        return null;
    }
    return (
        <Tip tip={blocked}>
            <Button
                variant={variant}
                disabled={Boolean(blocked)}
                onClick={() => openTrain(model.slug)}
            >
                {label ?? `Train v${nextNumber(model)}`}
            </Button>
        </Tip>
    );
}

export const JOB_STATUS: Record<JobStatus, { tone: Tone; label: string }> = {
    running: { tone: "info", label: "Running" },
    queued: { tone: "neutral", label: "Queued" },
    done: { tone: "success", label: "Done" },
    failed: { tone: "destructive", label: "Failed" },
    cancelled: { tone: "neutral", label: "Cancelled" },
};

export function JobStatusText({ job }: { job: Job }) {
    const status = JOB_STATUS[job.status];
    return (
        <span className="flex items-center gap-2">
            <StatusText tone={status.tone}>
                {status.label}
                {job.status === "running" && (
                    <span className="tabular-nums">{` · ${Math.round(job.progress * 100)}%`}</span>
                )}
            </StatusText>
            {job.status === "running" && (
                <ProgressBar value={job.progress} label={`Job ${job.id}`} className="w-16" />
            )}
        </span>
    );
}

export function BulkJobs({
    picked,
    retryable,
    cancellable,
    onClear,
    onDone,
}: {
    picked: number;
    retryable: Job[];
    cancellable: Job[];
    onClear: () => void;
    onDone: (what: string, count: number) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium tabular-nums">{`${picked} selected`}</span>
            <Button variant="outline" onClick={onClear}>
                <X aria-hidden="true" />
                Clear selection
            </Button>
            <Button
                variant="outline"
                disabled={retryable.length === 0}
                onClick={() => {
                    retryJobs(retryable.map((job) => job.id));
                    onDone("Retrying", retryable.length);
                }}
            >
                <RotateCcw aria-hidden="true" />
                Retry
            </Button>
            <Button
                variant="destructive"
                disabled={cancellable.length === 0}
                onClick={() => {
                    cancelJobs(cancellable.map((job) => job.id));
                    onDone("Cancelled", cancellable.length);
                }}
            >
                Cancel jobs
            </Button>
        </div>
    );
}

const STATUSES: JobStatus[] = ["running", "queued", "done", "failed", "cancelled"];

const METHODS = [
    { id: "sft", label: "Supervised fine-tuning (SFT)", ready: true },
    { id: "dpo", label: "DPO", ready: false },
    { id: "pretraining", label: "Continued pretraining", ready: false },
    { id: "rl", label: "Reinforcement learning", ready: false },
];

const ALL = "all";

function FilterSelect({
    label,
    value,
    onChange,
    options,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: { id: string; label: string; disabled?: boolean }[];
}) {
    return (
        <Select value={value} onValueChange={(next) => onChange(String(next))}>
            <SelectTrigger aria-label={label} className="w-auto min-w-40">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => (
                    <SelectItem
                        key={option.id}
                        value={option.id}
                        label={option.label}
                        disabled={option.disabled}
                        description={option.disabled ? "Coming soon" : undefined}
                    >
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function fromControl(event: MouseEvent): boolean {
    return (event.target as HTMLElement).closest("a,button,input,label,[role=checkbox]") !== null;
}

function JobRow({
    job,
    model,
    showModel,
    picked,
    selecting,
    onPick,
}: {
    job: Job;
    model: FlowModel | undefined;
    showModel: boolean;
    picked: boolean;
    selecting: boolean;
    onPick: (on: boolean) => void;
}) {
    const router = useRouter();
    const version = model && job.version !== null ? findVersion(model, job.version) : undefined;
    const settings = version?.settings;
    return (
        <TableRow
            className="cursor-pointer"
            data-state={picked ? "selected" : undefined}
            onClick={(event) => {
                if (fromControl(event)) {
                    return;
                }
                if (selecting) {
                    onPick(!picked);
                    return;
                }
                router.history.push(jobHref(job.id));
            }}
        >
            <TableCell className="w-10 pl-4">
                <Checkbox
                    aria-label={`Select job ${job.id}`}
                    checked={picked}
                    onCheckedChange={(value) => onPick(value === true)}
                />
            </TableCell>
            <TableCell>
                <Link href={jobHref(job.id)} className="font-mono text-sm hover:underline">
                    {`#${job.id}`}
                </Link>
            </TableCell>
            {showModel && (
                <TableCell>
                    {model ? (
                        <Link
                            href={modelHref(model.slug)}
                            className="flex items-center gap-2 hover:underline"
                        >
                            <ModelAvatar model={model} />
                            <span className="truncate font-medium">{model.name}</span>
                        </Link>
                    ) : (
                        job.model
                    )}
                </TableCell>
            )}
            <TableCell>
                {model && version ? (
                    <Link
                        href={versionHref(model.slug, version.number)}
                        className="font-medium hover:underline"
                    >
                        <VersionName version={version} />
                    </Link>
                ) : (
                    <span className="text-muted-foreground">–</span>
                )}
            </TableCell>
            <TableCell>
                <JobStatusText job={job} />
            </TableCell>
            <TableCell className="text-right">{pct(version?.scores?.[0])}</TableCell>
            <TableCell>
                SFT
                {settings && (
                    <span className="text-sm text-muted-foreground">{` · ${settings.adapter} r${settings.rank}`}</span>
                )}
            </TableCell>
            <TableCell className="text-right">{job.minutes ? `${job.minutes} min` : "–"}</TableCell>
            <TableCell className="pr-4 text-muted-foreground tabular-nums">
                {shortAgo(job)}
            </TableCell>
        </TableRow>
    );
}

export function TrainingJobsList({ scope, actions }: { scope?: FlowModel; actions?: ReactNode }) {
    const state = useFlowState();
    const toast = useToast();
    const [model, setModel] = useState(ALL);
    const [status, setStatus] = useState(ALL);
    const [method, setMethod] = useState(ALL);
    const [picked, setPicked] = useState<number[]>([]);
    const custom = state.models.filter((item) => item.kind === "custom");
    const all = state.jobs.filter(
        (job) => job.kind === "train" && (!scope || job.model === scope.slug),
    );
    const jobs = all.filter(
        (job) =>
            (scope || model === ALL || job.model === model) &&
            (status === ALL || job.status === status) &&
            (method === ALL || method === "sft"),
    );
    const chosen = all.filter((job) => picked.includes(job.id));
    const pick = (id: number, on: boolean) =>
        setPicked(on ? [...picked, id] : picked.filter((item) => item !== id));
    const every = jobs.length > 0 && jobs.every((job) => picked.includes(job.id));
    const filtering = model !== ALL || status !== ALL || method !== ALL;
    return (
        <PanelSection
            icon={GraduationCap}
            title={scope ? "Training runs" : "Runs"}
            description={
                scope
                    ? `Each run trained one version of ${scope.name}; open one for its loss and logs.`
                    : "Each run trained one version; open one for its data, settings, loss and logs."
            }
            actions={actions}
            bare
        >
            <div className="flex flex-col gap-3">
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                    {!scope && (
                        <FilterSelect
                            label="Model"
                            value={model}
                            onChange={setModel}
                            options={[
                                { id: ALL, label: "All models" },
                                ...custom.map((item) => ({ id: item.slug, label: item.name })),
                            ]}
                        />
                    )}
                    <FilterSelect
                        label="Status"
                        value={status}
                        onChange={setStatus}
                        options={[
                            { id: ALL, label: "Any status" },
                            ...STATUSES.map((item) => ({
                                id: item,
                                label: JOB_STATUS[item].label,
                            })),
                        ]}
                    />
                    <FilterSelect
                        label="Method"
                        value={method}
                        onChange={setMethod}
                        options={[
                            { id: ALL, label: "Any method" },
                            ...METHODS.map((item) => ({
                                id: item.id,
                                label: item.label,
                                disabled: !item.ready,
                            })),
                        ]}
                    />
                    {filtering && (
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setModel(ALL);
                                setStatus(ALL);
                                setMethod(ALL);
                            }}
                        >
                            Clear filters
                        </Button>
                    )}
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {jobs.length === all.length
                            ? `${all.length} ${all.length === 1 ? "job" : "jobs"}`
                            : `${jobs.length} of ${all.length} jobs`}
                    </span>
                    {picked.length > 0 && (
                        <div className="ml-auto flex flex-wrap items-center gap-2">
                            <BulkJobs
                                picked={picked.length}
                                retryable={chosen.filter(
                                    (job) => job.status === "failed" || job.status === "cancelled",
                                )}
                                cancellable={chosen.filter(
                                    (job) => job.status === "running" || job.status === "queued",
                                )}
                                onClear={() => setPicked([])}
                                onDone={(what, count) => {
                                    setPicked([]);
                                    toast({ title: `${what} ${count} jobs`, tone: "success" });
                                }}
                            />
                        </div>
                    )}
                </div>
                <div className="overflow-x-auto rounded-xl border bg-card">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-10 pl-4">
                                    <Checkbox
                                        aria-label="Select every job shown"
                                        checked={every}
                                        disabled={jobs.length === 0}
                                        onCheckedChange={(value) =>
                                            setPicked(
                                                value === true ? jobs.map((job) => job.id) : [],
                                            )
                                        }
                                    />
                                </TableHead>
                                <TableHead>Job</TableHead>
                                {!scope && <TableHead>Model</TableHead>}
                                <TableHead>Version</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="text-right">Score</TableHead>
                                <TableHead>Method</TableHead>
                                <TableHead className="text-right">Duration</TableHead>
                                <TableHead className="pr-4">Started</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {jobs.length === 0 && (
                                <TableRow>
                                    <TableCell
                                        colSpan={scope ? 8 : 9}
                                        className="py-6 text-center text-muted-foreground"
                                    >
                                        {all.length === 0
                                            ? scope?.dataset === null
                                                ? "No training runs yet. Attach a dataset on the Data page first."
                                                : "No training runs yet."
                                            : "No jobs match these filters."}
                                    </TableCell>
                                </TableRow>
                            )}
                            {jobs.map((job) => (
                                <JobRow
                                    key={job.id}
                                    job={job}
                                    model={state.models.find((item) => item.slug === job.model)}
                                    showModel={!scope}
                                    picked={picked.includes(job.id)}
                                    selecting={picked.length > 0}
                                    onPick={(on) => pick(job.id, on)}
                                />
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </div>
        </PanelSection>
    );
}

function TrainPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
    const state = useFlowState();
    const custom = state.models.filter((model) => model.kind === "custom");
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Train which model?</DialogTitle>
                    <DialogDescription>
                        Its next version trains from its base on its attached data.
                    </DialogDescription>
                </DialogHeader>
                {custom.length === 0 ? (
                    <p className="text-muted-foreground">No custom models yet.</p>
                ) : (
                    <ul className="flex flex-col divide-y rounded-md border">
                        {custom.map((model) => {
                            const blocked = trainBlock(model);
                            return (
                                <li key={model.slug}>
                                    <button
                                        type="button"
                                        disabled={Boolean(blocked)}
                                        onClick={() => {
                                            onClose();
                                            openTrain(model.slug);
                                        }}
                                        className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                    >
                                        <ModelAvatar model={model} />
                                        <span className="flex min-w-0 flex-1 flex-col">
                                            <span
                                                className={
                                                    blocked
                                                        ? "font-medium text-muted-foreground"
                                                        : "font-medium"
                                                }
                                            >
                                                {model.name}
                                            </span>
                                            <span className="truncate text-sm text-muted-foreground">
                                                {blocked ?? `On ${model.base}`}
                                            </span>
                                        </span>
                                        {!blocked && (
                                            <span className="text-sm text-muted-foreground tabular-nums">
                                                {`v${nextNumber(model)}`}
                                            </span>
                                        )}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </DialogContent>
        </Dialog>
    );
}

export function FlowTrainingPage() {
    const [picking, setPicking] = useState(false);
    return (
        <Page wide>
            <PageHeader
                title="Training"
                caption="Every training run across your models."
                actions={<Button onClick={() => setPicking(true)}>Train a model</Button>}
            />
            <PanelSections>
                <TrainingJobsList />
            </PanelSections>
            <TrainPicker open={picking} onClose={() => setPicking(false)} />
        </Page>
    );
}
