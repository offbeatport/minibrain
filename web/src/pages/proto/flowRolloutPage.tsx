import { useRouter } from "@tanstack/react-router";
import { Check, Circle, CircleSlash, ListChecks, Logs, Rocket, RotateCcw, X } from "lucide-react";
import { Button, Link, LogViewer, cn } from "obp-ui";
import { type ReactNode, useEffect } from "react";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { Page, PanelSection, PanelSections } from "~/components/Section";
import { ProgressBar } from "~/components/models/StatusText";
import { relativeTime } from "~/lib/time";
import { useCompute, useNow } from "./flowCompute";
import {
    type StepView,
    apiNameOf,
    cancelRollout,
    retryRollout,
    rolloutLog,
    stepViews,
    versionText,
    whereOf,
} from "./flowRollout";
import { JobStatusText } from "./flowTraining";
import {
    DEFAULT_CONTEXT,
    FLOW,
    type FlowModel,
    type Job,
    createdAt,
    jobHref,
    markVisited,
    modelHref,
    useFlowState,
} from "./modelsFlowData";
import { Crumbs } from "./modelsFlowParts";

function seconds(ms: number): string {
    return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function StepIcon({ step }: { step: StepView }) {
    const base = "size-4 shrink-0";
    if (step.state === "done") {
        return <Check aria-label="Done" className={cn(base, "text-success")} />;
    }
    if (step.state === "failed") {
        return <X aria-label="Failed" className={cn(base, "text-destructive")} />;
    }
    if (step.state === "skipped") {
        return <CircleSlash aria-label="Skipped" className={cn(base, "text-muted-foreground")} />;
    }
    if (step.state === "cancelled") {
        return <CircleSlash aria-label="Cancelled" className={cn(base, "text-muted-foreground")} />;
    }
    if (step.state === "running") {
        return (
            <span aria-label="Running" className="flex size-4 shrink-0 items-center justify-center">
                <span className="size-2 rounded-full bg-info" />
            </span>
        );
    }
    return <Circle aria-label="Not run" className={cn(base, "text-faint")} />;
}

function timing(step: StepView, now: number): string {
    if (step.start === null) {
        return "–";
    }
    if (step.end === null) {
        return seconds(now - step.start);
    }
    return seconds(step.end - step.start);
}

function StepRow({ step, index, now }: { step: StepView; index: number; now: number }) {
    const running = step.state === "running" && step.start !== null;
    return (
        <li className="flex items-start gap-3 px-panel py-3">
            <span className="w-5 shrink-0 pt-px text-right text-sm text-muted-foreground tabular-nums">
                {index + 1}
            </span>
            <span className="pt-0.5">
                <StepIcon step={step} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className={cn(step.state === "pending" && "text-muted-foreground")}>
                    {step.label}
                </span>
                <span className="text-sm text-muted-foreground">{step.note ?? step.detail}</span>
                {running && (
                    <ProgressBar
                        value={Math.min(1, (now - (step.start ?? now)) / step.ms)}
                        label={`${step.label} progress`}
                        className="mt-1 w-56"
                    />
                )}
            </span>
            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                {step.state === "pending" ? "Not run" : timing(step, now)}
            </span>
        </li>
    );
}

function verb(job: Job): string {
    return job.kind === "undeploy" ? "Undeploys" : "Deploys";
}

function Context({ job, model }: { job: Job; model: FlowModel | undefined }) {
    const rollout = job.rollout;
    const name = model?.name ?? job.model;
    const version = versionText(model, job);
    return (
        <span>
            {`${verb(job)} `}
            <Link href={modelHref(job.model)} className="text-primary hover:underline">
                {version ? `${name} ${version.split(",")[0]}` : name}
            </Link>
            {rollout?.pool ? ` to pool ${rollout.pool}` : ""}
            {` · by ${rollout?.by ?? "You"} · started ${relativeTime(createdAt(job))}`}
        </span>
    );
}

function Outcome({
    job,
    model,
    views,
}: { job: Job; model: FlowModel | undefined; views: StepView[] }) {
    const router = useRouter();
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const rollout = job.rollout;
    const api = apiNameOf(model, rollout?.target ?? job.model);
    const where = whereOf(job, compute);
    const name = model?.name ?? job.model;
    const version = versionText(model, job)?.split(",")[0];
    if (job.status === "done") {
        return (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/40 bg-success-soft px-4 py-3">
                <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">
                        {job.kind === "undeploy"
                            ? `${name} is undeployed`
                            : `${name}${version ? ` ${version}` : ""} is deployed on ${where}`}
                    </span>
                    <span className="text-sm">
                        {job.kind === "undeploy"
                            ? `Calls to ${api} get an error; versions and keys stay.`
                            : `Calls to ${api} on /v1 route to it. Health and replicas are on the model's Monitoring tab.`}
                    </span>
                </span>
                <Button variant="outline" asChild>
                    <Link href={modelHref(job.model, "monitoring")}>Open monitoring</Link>
                </Button>
            </div>
        );
    }
    if (job.status === "failed") {
        const at = views.findIndex((view) => view.state === "failed");
        const long = (rollout?.context ?? DEFAULT_CONTEXT) > DEFAULT_CONTEXT;
        return (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive-soft px-4 py-3">
                <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">
                        {`Deploy failed at step ${at + 1}: ${views[at]?.label ?? "load"}`}
                    </span>
                    <span className="text-sm">{job.error}</span>
                    {long && (
                        <span className="text-sm">
                            {`A ${rollout?.context.toLocaleString("en-US")}-token context reserves more GPU memory for the KV cache than is free. Nothing was routed${rollout?.change ? `; ${api} keeps its previous deployment` : ""}.`}
                        </span>
                    )}
                </span>
                {long && (
                    <Button
                        variant="outline"
                        onClick={() => {
                            const next = retryRollout(job, DEFAULT_CONTEXT);
                            if (next) {
                                router.history.push(jobHref(next));
                            }
                        }}
                    >
                        <RotateCcw />
                        {`Retry with ${DEFAULT_CONTEXT.toLocaleString("en-US")} tokens`}
                    </Button>
                )}
            </div>
        );
    }
    if (job.status === "cancelled") {
        return (
            <div className="rounded-md border bg-muted px-4 py-3">
                <span className="font-semibold">Cancelled</span>
                <span className="text-sm">{` · ${rollout?.by ?? "You"} cancelled it; the steps that ran were undone.`}</span>
            </div>
        );
    }
    return null;
}

export function RolloutJobPage({ job }: { job: Job }) {
    const router = useRouter();
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const now = useNow(250);
    const model = state.models.find((item) => item.slug === job.model);
    const views = stepViews(job, state, compute);
    const rollout = job.rollout;
    const running = job.status === "running";
    const start = views[0]?.start ?? new Date(createdAt(job)).getTime();
    const end = Math.max(...views.map((view) => view.end ?? 0));
    useEffect(() => {
        if (job.kind === "deploy") {
            markVisited("infra-rollout");
        }
        if (job.kind === "deploy" && job.status === "failed") {
            markVisited("infra-fail");
        }
    }, [job.kind, job.status]);
    const retry = () => {
        const next = retryRollout(job);
        if (next) {
            router.history.push(jobHref(next));
        }
    };
    return (
        <Page>
            <Crumbs
                items={[{ label: "Jobs", href: `${FLOW}/jobs` }, { label: `Job #${job.id}` }]}
            />
            <PageHeader
                title={`Job #${job.id}`}
                caption={<Context job={job} model={model} />}
                actions={
                    running ? (
                        <Button variant="outline" onClick={() => cancelRollout(job.id)}>
                            <X />
                            Cancel
                        </Button>
                    ) : job.status === "failed" || job.status === "cancelled" ? (
                        <Button variant="outline" onClick={retry}>
                            <RotateCcw />
                            Retry
                        </Button>
                    ) : undefined
                }
            />
            <Outcome job={job} model={model} views={views} />
            <PanelSections>
                <PanelSection
                    icon={ListChecks}
                    title="Steps"
                    description={
                        job.kind === "undeploy"
                            ? "Each step brings the deployment down; the base stays if another deployment needs it."
                            : "Each step brings the deployment to the state you asked for; a failed step stops the rollout before anything is routed."
                    }
                    flush
                >
                    <ol className="divide-y">
                        {views.map((view, index) => (
                            <StepRow key={view.key} step={view} index={index} now={now} />
                        ))}
                    </ol>
                </PanelSection>
                <div className="grid items-start gap-x-6 gap-y-8 lg:grid-cols-2">
                    <PanelSection icon={Rocket} title="Run" description="Status and timings.">
                        <Facts
                            items={[
                                ["Status", <JobStatusText key="s" job={job} />],
                                [
                                    "Started",
                                    <time
                                        key="t"
                                        dateTime={createdAt(job)}
                                        className="tabular-nums"
                                    >
                                        {relativeTime(createdAt(job))}
                                    </time>,
                                ],
                                [
                                    running ? "Running for" : "Took",
                                    <span key="d" className="tabular-nums">
                                        {running
                                            ? seconds(now - start)
                                            : job.seconds !== undefined
                                              ? `${job.seconds.toFixed(1)} s`
                                              : seconds(end - start)}
                                    </span>,
                                ],
                                ["Requested by", rollout?.by ?? "You"],
                            ]}
                        />
                    </PanelSection>
                    <PanelSection
                        icon={ListChecks}
                        title="Target"
                        description="The state this rollout brings the deployment to."
                    >
                        <Facts
                            items={[
                                [
                                    "Model",
                                    <Link
                                        key="m"
                                        href={modelHref(job.model)}
                                        className="text-primary hover:underline"
                                    >
                                        {model?.name ?? job.model}
                                    </Link>,
                                ],
                                ["Version", versionText(model, job) ?? "–"],
                                [
                                    "API name",
                                    <span key="a" className="font-mono text-sm">
                                        {apiNameOf(model, rollout?.target ?? job.model)}
                                    </span>,
                                ],
                                ["Pool", rollout?.pool || "–"],
                                [
                                    "Replicas",
                                    <span key="r" className="tabular-nums">
                                        {`${rollout?.slots.length ?? 0} on ${whereOf(job, compute)}`}
                                    </span>,
                                ],
                                ...(rollout && !rollout.loaded
                                    ? ([
                                          [
                                              "Context",
                                              <span key="c" className="tabular-nums">
                                                  {`${rollout.context.toLocaleString("en-US")} tokens`}
                                              </span>,
                                          ],
                                      ] as [string, ReactNode][])
                                    : []),
                            ]}
                        />
                    </PanelSection>
                </div>
                <PanelSection
                    icon={Logs}
                    title="Logs"
                    description="What the rollout and the engine printed, newest at the bottom."
                    bare
                >
                    <LogViewer
                        entries={rolloutLog(
                            job,
                            state,
                            compute,
                            running ? now : Number.POSITIVE_INFINITY,
                        )}
                        live={running}
                        label="Rollout log"
                        fileName={`job-${job.id}.log`}
                        maxHeight="20rem"
                    />
                </PanelSection>
            </PanelSections>
        </Page>
    );
}
