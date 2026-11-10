import { useRouter } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Timeline,
    TimelineDot,
    TimelineItem,
    cn,
    useToast,
} from "obp-ui";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "~/components/CopyButton";
import { Section } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { useSearchParam } from "~/lib/listSearch";
import { TrainButton, TrainingJobsList } from "./flowTraining";
import {
    type FlowModel,
    type FlowVersion,
    applyUpdate,
    compareHref,
    createKey,
    deleteVariantFiles,
    deployVariants,
    jobHref,
    jobOfVersion,
    newestFirst,
    pct,
    retryWithQLoRA,
    revokeKey,
    shortAgo,
    undeployVariants,
    useFlowState,
    variantKey,
    versionHref,
    versionState,
} from "./modelsFlowData";
import {
    MakeLiveButton,
    ScoreBadge,
    Tip,
    VersionName,
    VersionStatus,
    openConnect,
} from "./modelsFlowParts";

export function TrainingTab({ model }: { model: FlowModel }) {
    return <TrainingJobsList scope={model} actions={<TrainButton model={model} />} />;
}

const DOT_COLORS: Record<string, string> = {
    success: "var(--success)",
    info: "var(--info)",
    destructive: "var(--destructive)",
    neutral: "var(--faint)",
    warning: "var(--warning)",
    approval: "var(--approval)",
};

function VersionLine({
    model,
    version,
    picked,
    onPick,
}: {
    model: FlowModel;
    version: FlowVersion;
    picked: boolean;
    onPick: (on: boolean) => void;
}) {
    const toast = useToast();
    const router = useRouter();
    const memory = /memory/i.test(version.error ?? "");
    const newest = newestFirst(model)[0]?.number === version.number;
    const settings = version.settings;
    return (
        <TimelineItem
            dot={<TimelineDot color={DOT_COLORS[versionState(model, version).tone]} />}
            className="pb-2"
        >
            <div
                className={cn(
                    "-mt-0.5 flex min-h-10 flex-1 flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-2 py-1",
                    picked && "bg-accent",
                )}
            >
                <Checkbox
                    aria-label={`Select v${version.number} to compare`}
                    checked={picked}
                    disabled={!version.scores}
                    onCheckedChange={(value) => onPick(value === true)}
                />
                <span className="flex w-60 min-w-0 flex-col">
                    <Link
                        href={versionHref(model.slug, version.number)}
                        className="font-semibold hover:underline"
                    >
                        <VersionName version={version} />
                    </Link>
                    <span className="truncate text-sm text-muted-foreground">
                        {settings
                            ? `SFT · ${settings.adapter} r${settings.rank} · data v${version.data.number} · ${shortAgo(version)}`
                            : `Prompt only · data v${version.data.number} · ${shortAgo(version)}`}
                    </span>
                </span>
                <span className="w-16 text-right tabular-nums">{pct(version.scores?.[0])}</span>
                <span className="w-32">
                    <ScoreBadge model={model} version={version} />
                </span>
                <span className="w-44">
                    <VersionStatus model={model} version={version} />
                </span>
                <span className="ml-auto flex items-center gap-2">
                    {version.status === "training" && (
                        <Button variant="outline" asChild>
                            <Link href={jobHref(version.jobId)}>Watch</Link>
                        </Button>
                    )}
                    {version.status === "failed" && newest && memory && (
                        <Button
                            variant="outline"
                            onClick={() => {
                                const number = retryWithQLoRA(model.slug, version.number);
                                toast({
                                    title: `v${number} is training with QLoRA`,
                                    tone: "success",
                                });
                                const job = jobOfVersion(model.slug, number);
                                if (job) {
                                    router.history.push(jobHref(job));
                                }
                            }}
                        >
                            Retry with QLoRA
                        </Button>
                    )}
                    <MakeLiveButton model={model} version={version} variant="secondary" />
                </span>
            </div>
        </TimelineItem>
    );
}

export function VersionsTab({ model }: { model: FlowModel }) {
    const router = useRouter();
    const [picked, setPicked] = useState<number[]>([]);
    const pick = (number: number, on: boolean) =>
        setPicked(
            on
                ? [...picked.filter((n) => n !== number), number].slice(-2)
                : picked.filter((n) => n !== number),
        );
    const sorted = [...picked].sort((a, b) => a - b);
    if (model.versions.length === 0) {
        return (
            <Section title="Versions">
                <p className="text-muted-foreground">
                    No versions yet. Attach data on the Data page and v0 Baseline is scored at once.
                </p>
            </Section>
        );
    }
    return (
        <Section
            title="Versions"
            caption={`Newest first. Each is an immutable result, callable as ${model.slug}@N; live is a pointer to one of them.`}
            actions={
                <>
                    {picked.length > 0 && (
                        <Button variant="outline" onClick={() => setPicked([])}>
                            Clear
                        </Button>
                    )}
                    <Tip
                        tip={
                            picked.length === 2 ? null : "Tick two scored versions to compare them."
                        }
                    >
                        <Button
                            variant={picked.length === 2 ? "default" : "outline"}
                            disabled={picked.length !== 2}
                            onClick={() =>
                                router.history.push(compareHref(model.slug, sorted[0], sorted[1]))
                            }
                        >
                            {picked.length === 2
                                ? `Compare v${sorted[0]} and v${sorted[1]}`
                                : "Compare"}
                        </Button>
                    </Tip>
                </>
            }
        >
            <Timeline>
                {newestFirst(model).map((version) => (
                    <VersionLine
                        key={version.number}
                        model={model}
                        version={version}
                        picked={picked.includes(version.number)}
                        onPick={(on) => pick(version.number, on)}
                    />
                ))}
                <TimelineItem dot={<TimelineDot color="var(--faint)" />} className="pb-0">
                    <span className="-mt-0.5 flex min-h-10 flex-col justify-center px-2">
                        <span className="font-medium">{model.base}</span>
                        <span className="text-sm text-muted-foreground">
                            The base. Every version above is trained from it, not from the one
                            before.
                        </span>
                    </span>
                </TimelineItem>
            </Timeline>
        </Section>
    );
}

export function KeysTab({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const wantsNew = useSearchParam("new") === "1";
    const [shown, setShown] = useState<string | null>(null);
    const done = useRef(false);
    const keys = state.keys[model.slug] ?? [];
    const create = () => setShown(createKey(model.slug));
    useEffect(() => {
        if (wantsNew && !done.current) {
            done.current = true;
            setShown(createKey(model.slug));
        }
    }, [wantsNew, model.slug]);
    return (
        <div className="flex flex-col gap-4">
            <Section
                title="API keys"
                caption={`Keys that can call ${model.slug} and ${model.slug}@N. A key is shown once, when it is created.`}
                actions={
                    <>
                        <Button variant="outline" onClick={() => openConnect(model.slug)}>
                            Connect
                        </Button>
                        <Button onClick={create}>
                            <KeyRound aria-hidden="true" />
                            Create key
                        </Button>
                    </>
                }
                flush
            >
                {keys.length === 0 ? (
                    <p className="px-panel py-6 text-muted-foreground">No keys yet.</p>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="pl-panel">Key</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead>Last used</TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {keys.map((key) => (
                                <TableRow key={key.id}>
                                    <TableCell className="pl-panel font-mono text-sm">
                                        {key.prefix}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {shortAgo(key)}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {key.lastUsed === null
                                            ? "Never"
                                            : shortAgo({ hoursAgo: key.lastUsed })}
                                    </TableCell>
                                    <TableCell className="pr-panel text-right">
                                        <Button
                                            variant="outline"
                                            onClick={() => revokeKey(model.slug, key.id)}
                                        >
                                            Revoke
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </Section>
            <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Copy your key now</DialogTitle>
                        <DialogDescription>
                            It is not shown again. Connect has the base URL and code to use it.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex items-center gap-2 rounded-md border bg-muted py-1 pr-1 pl-3">
                        <span className="flex-1 font-mono text-sm break-all">{shown}</span>
                        <CopyButton value={shown ?? ""} label="Copy key" />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setShown(null);
                                openConnect(model.slug);
                            }}
                        >
                            Connect
                        </Button>
                        <DialogClose asChild>
                            <Button>Done</Button>
                        </DialogClose>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

export function VariantsTab({ model }: { model: FlowModel }) {
    const toast = useToast();
    return (
        <Section
            title="Variants"
            caption="The formats installed on this install. Each deployed one has its own model name."
            flush
        >
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-panel">Format</TableHead>
                        <TableHead>API name</TableHead>
                        <TableHead className="text-right">Size</TableHead>
                        <TableHead>Training</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Cost / 1k req.</TableHead>
                        <TableHead />
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {model.variants.map((item) => {
                        const key = variantKey(model.slug, item.id);
                        return (
                            <TableRow key={item.id}>
                                <TableCell className="pl-panel font-medium">
                                    {item.format}
                                </TableCell>
                                <TableCell className="font-mono text-sm">{item.apiName}</TableCell>
                                <TableCell className="text-right">{item.size}</TableCell>
                                <TableCell className="text-muted-foreground">
                                    {item.trainable ? "Trainable" : "Serve-only"}
                                </TableCell>
                                <TableCell>
                                    {item.live ? (
                                        <StatusText tone="success">
                                            {`Deployed${item.replicas.length > 1 ? ` · ${item.replicas.length} replicas` : ""}`}
                                        </StatusText>
                                    ) : (
                                        <span className="text-muted-foreground">Not deployed</span>
                                    )}
                                    {item.update && (
                                        <span className="block text-sm text-info">
                                            Update available
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="text-right">{`${item.gpuSeconds.toFixed(1)} GPU·s`}</TableCell>
                                <TableCell className="pr-panel text-right">
                                    <span className="inline-flex gap-2">
                                        {item.update && (
                                            <Button
                                                variant="outline"
                                                onClick={() => {
                                                    applyUpdate(model.slug, item.id);
                                                    toast({
                                                        title: `${item.format} updated`,
                                                        tone: "success",
                                                    });
                                                }}
                                            >
                                                Update
                                            </Button>
                                        )}
                                        <Button
                                            variant="outline"
                                            onClick={() =>
                                                item.live
                                                    ? undeployVariants([key])
                                                    : deployVariants([key])
                                            }
                                        >
                                            {item.live ? "Undeploy" : "Deploy"}
                                        </Button>
                                        <Tip tip={item.live ? "Undeploy it first." : null}>
                                            <Button
                                                variant="outline"
                                                disabled={item.live}
                                                onClick={() => deleteVariantFiles([key])}
                                            >
                                                Delete files
                                            </Button>
                                        </Tip>
                                    </span>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </Section>
    );
}
