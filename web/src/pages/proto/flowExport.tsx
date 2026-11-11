import { useRouter } from "@tanstack/react-router";
import { Download } from "lucide-react";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
    RadioGroup,
    RadioGroupItem,
    SegmentedTabs,
    cn,
    useToast,
} from "obp-ui";
import { useState } from "react";
import { CopyButton } from "~/components/CopyButton";
import { Section } from "~/components/Section";
import { ProgressBar, StatusText } from "~/components/models/StatusText";
import {
    type ExportArtifact,
    type ExportFormat,
    type FlowModel,
    type FlowVersion,
    type Job,
    exportOption,
    exportSize,
    jobHref,
    startExport,
    useFlowState,
} from "./modelsFlowData";

type Choice = "adapter" | "merged" | "gguf";

const CHOICES: { id: Choice; label: string; file: string; runs: string }[] = [
    {
        id: "adapter",
        label: "Adapter only",
        file: "safetensors",
        runs: "Loads on the same base in minibrain, vLLM or PEFT.",
    },
    {
        id: "merged",
        label: "Merged full model",
        file: "safetensors",
        runs: "The base with the adapter folded in; runs on any server for Hugging Face models.",
    },
    {
        id: "gguf",
        label: "Merged and quantised GGUF",
        file: "GGUF",
        runs: "For llama.cpp or Ollama, on a laptop or CPU server.",
    },
];

const QUANTS: { key: ExportFormat; label: string }[] = [
    { key: "gguf-q4", label: "Q4" },
    { key: "gguf-q8", label: "Q8" },
];

function formatOf(choice: Choice, quant: ExportFormat): ExportFormat {
    return choice === "gguf" ? quant : choice;
}

function ExportBody({
    model,
    version,
    onClose,
}: {
    model: FlowModel;
    version: FlowVersion;
    onClose: () => void;
}) {
    const router = useRouter();
    const toast = useToast();
    const [choice, setChoice] = useState<Choice>("adapter");
    const [quant, setQuant] = useState<ExportFormat>("gguf-q4");
    const format = formatOf(choice, quant);
    const start = () => {
        const job = startExport(model.slug, version.number, format);
        onClose();
        toast({
            title: `Exporting v${version.number} of ${model.name}`,
            description: `Job #${job}: ${exportOption(format).label.toLowerCase()}.`,
            tone: "success",
        });
        router.history.push(jobHref(job));
    };
    return (
        <>
            <DialogHeader>
                <DialogTitle>{`Export v${version.number}`}</DialogTitle>
                <DialogDescription>
                    {`Writes ${model.name} v${version.number} to files you can download and run elsewhere. Each file carries its SHA-256.`}
                </DialogDescription>
            </DialogHeader>
            <RadioGroup
                value={choice}
                onValueChange={(value) => setChoice(value as Choice)}
                aria-label="Export format"
                className="gap-0 divide-y rounded-md border"
            >
                {CHOICES.map((item) => {
                    const size =
                        item.id === "gguf"
                            ? QUANTS.map(
                                  (q) => `${q.label} ~${exportSize(model, version, q.key)}`,
                              ).join(", ")
                            : `~${exportSize(model, version, item.id)}`;
                    return (
                        <label
                            key={item.id}
                            htmlFor={`export-${item.id}`}
                            className={cn(
                                "flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-secondary",
                                choice === item.id && "bg-accent hover:bg-accent",
                            )}
                        >
                            <RadioGroupItem
                                id={`export-${item.id}`}
                                value={item.id}
                                className="mt-0.5"
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                                    <span className="font-medium">{item.label}</span>
                                    <span className="text-sm text-muted-foreground tabular-nums">
                                        {`${item.file} · ${size}`}
                                    </span>
                                </span>
                                <span className="text-sm text-muted-foreground">{item.runs}</span>
                                {item.id === "gguf" && choice === "gguf" && (
                                    <span className="flex items-center gap-3 pt-2">
                                        <SegmentedTabs
                                            tabs={QUANTS}
                                            active={quant}
                                            onSelect={(key) => setQuant(key as ExportFormat)}
                                        />
                                        <span className="text-sm text-muted-foreground">
                                            {quant === "gguf-q4"
                                                ? "Smaller; a little less accurate."
                                                : "Closer to the original; twice the size."}
                                        </span>
                                    </span>
                                )}
                            </span>
                        </label>
                    );
                })}
            </RadioGroup>
            <p className="text-sm text-muted-foreground tabular-nums">
                {`Runs as a job on gpu-a10-1, about ${format === "adapter" ? "1 minute" : "3 minutes"}. Download it from v${version.number}'s page when it is done.`}
            </p>
            <DialogFooter>
                <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button onClick={start}>{`Export ~${exportSize(model, version, format)}`}</Button>
            </DialogFooter>
        </>
    );
}

export function ExportDialog({
    model,
    version,
    open,
    onClose,
}: {
    model: FlowModel;
    version: FlowVersion;
    open: boolean;
    onClose: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="sm:max-w-xl">
                {open && <ExportBody model={model} version={version} onClose={onClose} />}
            </DialogContent>
        </Dialog>
    );
}

function fileName(model: FlowModel, version: FlowVersion, format: ExportFormat): string {
    const stem = `${model.slug}-v${version.number}`;
    if (format === "adapter") {
        return `${stem}-adapter.safetensors`;
    }
    if (format === "merged") {
        return `${stem}-merged.safetensors`;
    }
    return `${stem}-${format === "gguf-q4" ? "Q4_K_M" : "Q8_0"}.gguf`;
}

export function ArtifactLine({
    model,
    version,
    artifact,
    job,
    here = false,
}: {
    model: FlowModel;
    version: FlowVersion;
    artifact: ExportArtifact;
    job: Job | undefined;
    here?: boolean;
}) {
    const toast = useToast();
    const option = exportOption(artifact.format);
    const done = job?.status === "done";
    const name = fileName(model, version, artifact.format);
    return (
        <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-panel py-3">
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{option.label}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {`${exportSize(model, version, artifact.format)} · ${option.runs}`}
                    </span>
                </span>
                {done ? (
                    <span className="flex min-w-0 items-center gap-1">
                        <span className="shrink-0 text-sm text-muted-foreground">SHA-256</span>
                        <span className="truncate font-mono text-sm" title={artifact.sha}>
                            {artifact.sha}
                        </span>
                        <span className="-my-1.5 shrink-0">
                            <CopyButton value={artifact.sha} label="Copy SHA-256" />
                        </span>
                    </span>
                ) : (
                    <span className="flex items-center gap-3">
                        <StatusText tone="info">
                            <span className="tabular-nums">{`Exporting ${Math.round((job?.progress ?? 0) * 100)}%`}</span>
                        </StatusText>
                        <ProgressBar
                            value={job?.progress ?? 0}
                            label={`Export ${artifact.jobId}`}
                            className="w-32"
                        />
                    </span>
                )}
            </span>
            <span className="flex items-center gap-2">
                {!here && (
                    <Button variant="outline" asChild>
                        <Link href={jobHref(artifact.jobId)}>{`Job #${artifact.jobId}`}</Link>
                    </Button>
                )}
                <Button
                    variant={done ? "default" : "outline"}
                    disabled={!done}
                    onClick={() =>
                        toast({
                            title: "Not in the prototype",
                            description: `Would download ${name}.`,
                        })
                    }
                >
                    <Download aria-hidden="true" />
                    Download
                </Button>
            </span>
        </li>
    );
}

export function ExportsSection({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const state = useFlowState();
    const artifacts = state.exports.filter(
        (item) => item.slug === model.slug && item.version === version.number,
    );
    if (artifacts.length === 0) {
        return null;
    }
    return (
        <Section
            title="Exports"
            caption="Files written from this version. The SHA-256 lets the place that runs it check the file."
            flush
        >
            <ul className="divide-y">
                {[...artifacts].reverse().map((artifact) => (
                    <ArtifactLine
                        key={artifact.jobId}
                        model={model}
                        version={version}
                        artifact={artifact}
                        job={state.jobs.find((job) => job.id === artifact.jobId)}
                    />
                ))}
            </ul>
        </Section>
    );
}
