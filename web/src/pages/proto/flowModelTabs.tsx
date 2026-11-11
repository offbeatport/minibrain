import { useRouter } from "@tanstack/react-router";
import { History, KeyRound, Layers } from "lucide-react";
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
    useToast,
} from "obp-ui";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "~/components/CopyButton";
import { PanelSection, PanelSections } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { useSearchParam } from "~/lib/listSearch";
import { Inline } from "./flowHeader";
import { useCan } from "./flowOverlays";
import { TrainButton, TrainingJobsList } from "./flowTraining";
import { TrainingChart } from "./flowTrainingChart";
import {
    FLOW,
    type FlowModel,
    type FlowVersion,
    applyUpdate,
    compareHref,
    createKey,
    deleteVariantFiles,
    deleteVersions,
    deployVariants,
    jobHref,
    jobOfVersion,
    newestFirst,
    pct,
    pendingFeedback,
    retryVersion,
    revokeKey,
    shortAgo,
    undeployVariants,
    useFlowState,
    variantKey,
    versionHref,
    versionKey,
    versionState,
} from "./modelsFlowData";
import { type Confirm, ConfirmDialog } from "./modelsFlowDialogs";
import { MakeLiveButton, ScoreBadge, Tip, VersionName, openConnect } from "./modelsFlowParts";

export function TrainingTab({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const pending = pendingFeedback(state, model.slug).length;
    const facts = [
        pending > 0 ? (
            <span key="pending" className="flex items-baseline gap-2">
                {`${pending} feedback ${pending === 1 ? "row" : "rows"} to review`}
                <span aria-hidden="true" className="text-faint">
                    ·
                </span>
                <Link href={`${FLOW}/feedback`} className="text-primary hover:underline">
                    Review
                </Link>
            </span>
        ) : null,
        model.accepted > 0 ? (
            <span key="accepted">
                {`${model.accepted} reviewed ${model.accepted === 1 ? "row joins" : "rows join"} the next run`}
            </span>
        ) : null,
    ];
    return (
        <div className="flex flex-col gap-2">
            {(pending > 0 || model.accepted > 0) && (
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-muted-foreground tabular-nums">
                    <Inline items={facts} />
                </p>
            )}
            <PanelSections>
                <TrainingChart model={model} />
                <TrainingJobsList scope={model} actions={<TrainButton model={model} />} />
            </PanelSections>
        </div>
    );
}

export function VersionStatusDot({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const state = versionState(model, version);
    if (version.status === "training") {
        return (
            <StatusText tone="info">
                <span className="tabular-nums">{`Training ${Math.round((version.progress ?? 0) * 100)}%`}</span>
            </StatusText>
        );
    }
    const tone = state.tone === "approval" ? "info" : state.tone;
    const text = (
        <StatusText tone={tone}>
            <span className="tabular-nums">{state.label}</span>
        </StatusText>
    );
    if (version.status !== "failed" || !version.error) {
        return text;
    }
    return <Tip tip={version.error}>{text}</Tip>;
}

function VersionRow({
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
    const newest = newestFirst(model)[0]?.number === version.number;
    const settings = version.settings;
    return (
        <TableRow data-state={picked ? "selected" : undefined}>
            <TableCell className="w-10 pl-4">
                <Checkbox
                    aria-label={`Select v${version.number}`}
                    checked={picked}
                    onCheckedChange={(value) => onPick(value === true)}
                />
            </TableCell>
            <TableCell>
                <span className="flex min-w-0 flex-col">
                    <Link
                        href={versionHref(model.slug, version.number)}
                        className="font-medium hover:underline"
                    >
                        <VersionName version={version} />
                    </Link>
                    <span className="truncate text-sm text-muted-foreground">
                        {settings
                            ? `SFT · ${settings.adapter} r${settings.rank} · data v${version.data.number}`
                            : `Prompt only · data v${version.data.number}`}
                    </span>
                </span>
            </TableCell>
            <TableCell>
                <VersionStatusDot model={model} version={version} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{pct(version.scores?.[0])}</TableCell>
            <TableCell>
                <ScoreBadge model={model} version={version} />
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
                {shortAgo(version)}
            </TableCell>
            <TableCell className="pr-4 text-right">
                <span className="inline-flex items-center gap-2">
                    {version.status === "training" && (
                        <Button variant="outline" asChild>
                            <Link href={jobHref(version.jobId)}>Watch</Link>
                        </Button>
                    )}
                    {version.status === "failed" && newest && (
                        <Button
                            variant="outline"
                            onClick={() => {
                                const number = retryVersion(model.slug, version.number);
                                toast({ title: `v${number} is training`, tone: "success" });
                                const job = jobOfVersion(model.slug, number);
                                if (job) {
                                    router.history.push(jobHref(job));
                                }
                            }}
                        >
                            {/memory/i.test(version.error ?? "") ? "Retry with QLoRA" : "Retry"}
                        </Button>
                    )}
                    <MakeLiveButton model={model} version={version} variant="outline" />
                </span>
            </TableCell>
        </TableRow>
    );
}

export function VersionsTab({ model }: { model: FlowModel }) {
    const router = useRouter();
    const toast = useToast();
    const can = useCan("builder");
    const [picked, setPicked] = useState<number[]>([]);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const pick = (number: number, on: boolean) =>
        setPicked(
            on
                ? [...picked.filter((n) => n !== number), number]
                : picked.filter((n) => n !== number),
        );
    const chosen = model.versions.filter((version) => picked.includes(version.number));
    const comparable = chosen.filter((version) => version.scores);
    const sorted = comparable.map((version) => version.number).sort((a, b) => a - b);
    const deletable = chosen.filter((version) => version.number !== model.live);
    const ordered = newestFirst(model);
    const every = ordered.length > 0 && ordered.every((version) => picked.includes(version.number));
    if (model.versions.length === 0) {
        return (
            <PanelSections>
                <PanelSection
                    icon={History}
                    title="Versions"
                    description={`Every version is trained from ${model.base}, not from the one before.`}
                >
                    <p className="text-muted-foreground">
                        No versions yet. Attach data on the Data page and v0 Baseline is scored at
                        once.
                    </p>
                </PanelSection>
            </PanelSections>
        );
    }
    const remove = () =>
        setConfirm({
            title:
                deletable.length === 1
                    ? `Delete v${deletable[0].number} of ${model.name}?`
                    : `Delete ${deletable.length} versions of ${model.name}?`,
            description: (
                <p>
                    {`${deletable.map((version) => `${model.slug}@${version.number}`).join(", ")} stop answering; adapters, scores and cards are removed.`}
                    {chosen.length > deletable.length && ` Live v${model.live} is kept.`}
                </p>
            ),
            label: deletable.length === 1 ? "Delete version" : "Delete versions",
            run: () => {
                deleteVersions(deletable.map((version) => versionKey(model.slug, version.number)));
                setPicked([]);
                toast({
                    title: `Deleted ${deletable.length} ${deletable.length === 1 ? "version" : "versions"}`,
                    tone: "success",
                });
            },
        });
    return (
        <PanelSections>
            <PanelSection
                icon={History}
                title="Versions"
                description={`Every version is trained from ${model.base}, not from the one before.`}
                actions={
                    <>
                        {picked.length > 0 && (
                            <Button variant="outline" onClick={() => setPicked([])}>
                                Clear
                            </Button>
                        )}
                        <Tip
                            tip={
                                sorted.length === 2
                                    ? null
                                    : "Tick two scored versions to compare them."
                            }
                        >
                            <Button
                                variant="outline"
                                disabled={sorted.length !== 2}
                                onClick={() =>
                                    router.history.push(
                                        compareHref(model.slug, sorted[0], sorted[1]),
                                    )
                                }
                            >
                                {sorted.length === 2
                                    ? `Compare v${sorted[0]} and v${sorted[1]}`
                                    : "Compare"}
                            </Button>
                        </Tip>
                        {can && (
                            <Tip
                                tip={
                                    picked.length === 0
                                        ? "Tick the versions to delete."
                                        : deletable.length === 0
                                          ? "The live version cannot be deleted."
                                          : null
                                }
                            >
                                <Button
                                    variant="outline"
                                    disabled={deletable.length === 0}
                                    onClick={remove}
                                >
                                    {deletable.length > 0 ? `Delete ${deletable.length}` : "Delete"}
                                </Button>
                            </Tip>
                        )}
                    </>
                }
                flush
            >
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-10 pl-4">
                                <Checkbox
                                    aria-label="Select every version"
                                    checked={every}
                                    onCheckedChange={(value) =>
                                        setPicked(
                                            value === true
                                                ? ordered.map((version) => version.number)
                                                : [],
                                        )
                                    }
                                />
                            </TableHead>
                            <TableHead>Version</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">{model.metrics[0]}</TableHead>
                            <TableHead>Against live</TableHead>
                            <TableHead>Created</TableHead>
                            <TableHead className="pr-4">
                                <span className="sr-only">Actions</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {ordered.map((version) => (
                            <VersionRow
                                key={version.number}
                                model={model}
                                version={version}
                                picked={picked.includes(version.number)}
                                onPick={(on) => pick(version.number, on)}
                            />
                        ))}
                    </TableBody>
                </Table>
                <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
            </PanelSection>
        </PanelSections>
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
        <PanelSections>
            <PanelSection
                icon={KeyRound}
                title="API keys"
                description={`Keys that can call ${model.slug} and ${model.slug}@N; each is shown once, when it is created.`}
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
            </PanelSection>
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
        </PanelSections>
    );
}

export function VariantsTab({ model }: { model: FlowModel }) {
    const toast = useToast();
    return (
        <PanelSections>
            <PanelSection
                icon={Layers}
                title="Variants"
                description="The formats on this install. Each deployed one has its own model name."
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
                                    <TableCell className="font-mono text-sm">
                                        {item.apiName}
                                    </TableCell>
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
                                            <span className="text-muted-foreground">
                                                Not deployed
                                            </span>
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
            </PanelSection>
        </PanelSections>
    );
}
