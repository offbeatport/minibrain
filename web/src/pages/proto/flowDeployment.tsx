import { useRouter } from "@tanstack/react-router";
import { History, Logs, PowerOff, Server, SlidersHorizontal } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Link,
    LogViewer,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast,
} from "obp-ui";
import { useState } from "react";
import { PanelSection } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { relativeTime } from "~/lib/time";
import {
    type Placement,
    deployedPlacements,
    deploymentOf,
    placementNames,
    unhealthyReason,
    useCompute,
    useNow,
} from "./flowCompute";
import { DeployDialog } from "./flowDeploy";
import { useCan } from "./flowOverlays";
import { engineLog, startUndeploy, undeployTargets, versionText, whereOf } from "./flowRollout";
import { JobStatusText } from "./flowTraining";
import {
    type FlowModel,
    type Job,
    createdAt,
    failedRollout,
    jobHref,
    rolloutsOf,
    useFlowState,
    variantKey,
} from "./modelsFlowData";
import { type Confirm, ConfirmDialog } from "./modelsFlowDialogs";

type Compute = ReturnType<typeof useCompute>;

type Replica = {
    key: string;
    target: string;
    label: string | null;
    placement: Placement;
    since: number;
};

const DAY_MS = 24 * 3600000;

function jobEnd(job: Job): number {
    const start = job.atMs ?? Date.now() - job.hoursAgo * 3600000;
    return start + (job.seconds ?? 0) * 1000;
}

function replicasOf(model: FlowModel, jobs: Job[]): Replica[] {
    const targets =
        model.kind === "custom"
            ? model.deployed
                ? [{ target: model.slug, label: model.live === null ? null : `v${model.live}` }]
                : []
            : model.variants
                  .filter((item) => item.live)
                  .map((item) => ({ target: variantKey(model.slug, item.id), label: item.format }));
    return targets.flatMap(({ target, label }) => {
        const last = jobs.find(
            (job) =>
                job.rollout?.target === target &&
                job.kind === "deploy" &&
                job.status === "done" &&
                (job.rollout?.steps.some((step) => step.key === "load") ?? false),
        );
        const since = last ? jobEnd(last) : Date.now() - 75 * DAY_MS;
        return deployedPlacements(target).map((placement) => ({
            key: `${target}:${placement.machine}:${placement.gpu}`,
            target,
            label,
            placement,
            since,
        }));
    });
}

function uptime(since: number, now: number): string {
    const minutes = Math.max(0, Math.floor((now - since) / 60000));
    if (minutes < 60) {
        return `${Math.max(1, minutes)} min`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} h ${minutes % 60} min`;
    }
    return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function gpuText(placement: Placement, compute: Compute): string {
    const machine = compute.machines.find((item) => item.id === placement.machine);
    const gpu = machine?.gpus.find((item) => item.index === placement.gpu);
    return gpu ? `GPU ${gpu.index} · ${gpu.name}` : "CPU and RAM";
}

function EngineLogs({
    model,
    replica,
    onClose,
}: {
    model: FlowModel;
    replica: Replica | null;
    onClose: () => void;
}) {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const now = useNow(1000);
    const unhealthy = unhealthyReason(model, state.mode);
    return (
        <Dialog open={replica !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-5xl [&>*]:min-w-0">
                {replica && (
                    <>
                        <DialogHeader>
                            <DialogTitle>
                                {`Engine logs · ${placementNames([replica.placement], compute)}`}
                            </DialogTitle>
                            <DialogDescription>
                                {`The engine serving ${model.name}${replica.label ? ` ${replica.label}` : ""}, as it runs. Turn on Health checks to see every probe.`}
                            </DialogDescription>
                        </DialogHeader>
                        <LogViewer
                            entries={engineLog(
                                model,
                                replica.placement,
                                compute,
                                now,
                                replica.since,
                                unhealthy,
                            )}
                            live
                            quietSource="health"
                            quietLabel="Health checks"
                            label="Engine log"
                            fileName={`${replica.placement.machine}-engine.log`}
                            maxHeight="28rem"
                        />
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

function StateLine({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const deployment = deploymentOf(model, compute);
    const failed = failedRollout(state, model.slug);
    const unhealthy = unhealthyReason(model, state.mode);
    if (deployment?.job) {
        return (
            <p className="flex flex-wrap items-center gap-x-2">
                <StatusText tone="info">
                    {deployment.phase === "undeploying" ? "Undeploying" : "Deploying"}
                </StatusText>
                <Link href={jobHref(deployment.job)} className="text-primary hover:underline">
                    {`View rollout #${deployment.job}`}
                </Link>
            </p>
        );
    }
    if (failed) {
        return (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive-soft px-4 py-3">
                <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">
                        {model.deployed ? "The last rollout failed" : "Deploy failed"}
                    </span>
                    <span className="text-sm">{failed.error}</span>
                </span>
                <Button variant="outline" asChild>
                    <Link href={jobHref(failed.id)}>{`View rollout #${failed.id}`}</Link>
                </Button>
            </div>
        );
    }
    if (unhealthy) {
        return (
            <div className="rounded-md border border-warning/40 bg-warning-soft px-4 py-3">
                <span className="font-semibold">Unhealthy</span>
                <span className="text-sm">{`: ${unhealthy}. It is kept alive with restarts, without a new job.`}</span>
            </div>
        );
    }
    return null;
}

function ReplicaTable({
    model,
    rows,
    onLogs,
}: {
    model: FlowModel;
    rows: Replica[];
    onLogs: (replica: Replica) => void;
}) {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const now = useNow(30000);
    const unhealthy = unhealthyReason(model, state.mode);
    return (
        <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-panel">Machine</TableHead>
                        <TableHead>GPU</TableHead>
                        <TableHead>{model.kind === "custom" ? "Version" : "Format"}</TableHead>
                        <TableHead>Uptime</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="pr-panel text-right">
                            <span className="sr-only">Logs</span>
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => (
                        <TableRow key={row.key}>
                            <TableCell className="pl-panel font-mono text-sm">
                                {row.placement.machine}
                            </TableCell>
                            <TableCell>{gpuText(row.placement, compute)}</TableCell>
                            <TableCell>{row.label ?? "–"}</TableCell>
                            <TableCell className="tabular-nums">{uptime(row.since, now)}</TableCell>
                            <TableCell>
                                {unhealthy ? (
                                    <StatusText tone="warning">Unhealthy · restarting</StatusText>
                                ) : (
                                    <StatusText tone="success">Healthy</StatusText>
                                )}
                            </TableCell>
                            <TableCell className="pr-panel text-right">
                                <Button variant="outline" onClick={() => onLogs(row)}>
                                    <Logs />
                                    Logs
                                </Button>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function RolloutHistory({ jobs, compute }: { jobs: Job[]; compute: Compute }) {
    const state = useFlowState();
    if (jobs.length === 0) {
        return <p className="text-muted-foreground">No rollouts yet.</p>;
    }
    return (
        <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-panel">Job</TableHead>
                        <TableHead>Rollout</TableHead>
                        <TableHead>Where</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>By</TableHead>
                        <TableHead>Started</TableHead>
                        <TableHead className="pr-panel text-right">Took</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {jobs.map((job) => {
                        const model = state.models.find((item) => item.slug === job.model);
                        const version = versionText(model, job)?.split(",")[0];
                        return (
                            <TableRow key={job.id}>
                                <TableCell className="pl-panel">
                                    <Link
                                        href={jobHref(job.id)}
                                        className="font-mono text-sm hover:underline"
                                    >
                                        {`#${job.id}`}
                                    </Link>
                                </TableCell>
                                <TableCell>
                                    {`${job.kind === "undeploy" ? "Undeploy" : "Deploy"}${version ? ` ${version}` : ""}`}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {whereOf(job, compute)}
                                </TableCell>
                                <TableCell>
                                    <JobStatusText job={job} />
                                </TableCell>
                                <TableCell>{job.rollout?.by ?? "You"}</TableCell>
                                <TableCell className="text-muted-foreground tabular-nums">
                                    {relativeTime(createdAt(job))}
                                </TableCell>
                                <TableCell className="pr-panel text-right tabular-nums">
                                    {job.status === "running" || job.seconds === undefined
                                        ? "–"
                                        : `${job.seconds.toFixed(1)} s`}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}

function DeploymentActions({ model }: { model: FlowModel }) {
    const router = useRouter();
    const toast = useToast();
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const busy = Boolean(deploymentOf(model, compute)?.job);
    const [editing, setEditing] = useState(false);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const undeploy = () =>
        setConfirm({
            title: `Undeploy ${model.name}?`,
            description: (
                <p>{`Apps calling ${model.slug} get errors at once. Versions and keys stay.`}</p>
            ),
            label: "Undeploy",
            run: () => {
                const ids = undeployTargets(model).map((target) => startUndeploy(model, target));
                const first = ids[0];
                toast({
                    title: `Undeploying ${model.name}`,
                    description: `Undeploy job #${first} stops routing and unloads it.`,
                    action: first
                        ? {
                              label: "View rollout",
                              onClick: () => router.history.push(jobHref(first)),
                          }
                        : undefined,
                });
            },
        });
    return (
        <>
            <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                <SlidersHorizontal />
                Edit
            </Button>
            <Button variant="outline" disabled={busy} onClick={undeploy}>
                <PowerOff />
                Undeploy
            </Button>
            <DeployDialog model={model} mode="change" open={editing} onOpenChange={setEditing} />
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
        </>
    );
}

export function DeploymentSections({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const [open, setOpen] = useState<Replica | null>(null);
    const jobs = rolloutsOf(state, model.slug);
    const rows = replicasOf(model, jobs);
    const builder = useCan("builder");
    return (
        <>
            <PanelSection
                icon={Server}
                anchor="deployment"
                title="Deployment"
                description={
                    rows.length > 0
                        ? `${rows.length} ${rows.length === 1 ? "replica" : "replicas"}, kept alive with restarts and reloads. Open a replica's engine logs.`
                        : "Not deployed: nothing serves it."
                }
                actions={
                    builder && model.deployed ? <DeploymentActions model={model} /> : undefined
                }
                bare
            >
                <div className="flex flex-col gap-3">
                    <StateLine model={model} />
                    {rows.length > 0 && <ReplicaTable model={model} rows={rows} onLogs={setOpen} />}
                </div>
            </PanelSection>
            <PanelSection
                icon={History}
                title="Rollout history"
                description="Every Deploy and Undeploy job for this model, newest first."
                bare
            >
                <RolloutHistory jobs={jobs} compute={compute} />
            </PanelSection>
            <EngineLogs model={model} replica={open} onClose={() => setOpen(null)} />
        </>
    );
}
