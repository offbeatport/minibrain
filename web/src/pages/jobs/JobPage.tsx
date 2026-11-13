import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { MoreHorizontal, SlidersHorizontal, Trash2 } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Link,
    useToast,
} from "obp-ui";
import { type ReactNode, useEffect, useState } from "react";
import { type JobDetail, api, unwrap } from "~/api/client";
import { useJobMetrics } from "~/api/jobPageQueries";
import { isActiveJob, useJob } from "~/api/queries";
import { Breadcrumbs } from "~/components/Breadcrumbs";
import { DeleteJobsDialog, deleteRefusal, deleteSummary } from "~/components/DeleteJobs";
import { Facts } from "~/components/Facts";
import { JobLogsSection } from "~/components/JobLogs";
import { canCancel, canRetry } from "~/components/JobSelection";
import { ModelName } from "~/components/ModelName";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, PanelSection, PanelSections, Stat } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { count } from "~/lib/format";
import { MODEL_JOB_KINDS, TRAIN_KIND, jobDuration, kindNoun, kindVerb } from "~/lib/jobs";
import {
    JOBS_PATH,
    TRAINING_PATH,
    jobHref,
    modelPageHref,
    modelVersionHref,
} from "~/lib/modelLinks";
import { bytes, relativeTime } from "~/lib/time";
import { ProgressSection, ScoresSection } from "./ProgressPanels";
import { LossSection, RateSection } from "./TrainingPanel";
import { JobState } from "./jobCells";

type Fact = [string, ReactNode];

const LINK = "text-primary hover:underline";
const BASE_KINDS = ["download", "import", "verify", "repair"];
const STRATEGIES: Record<string, string> = { lora: "LoRA", qlora: "QLoRA" };
const SETTING_NAMES: Record<string, string> = {
    rank: "rank",
    learning_rate: "learning rate",
    epochs: "epochs",
    max_rows: "rows per run",
    seq_len: "sequence length",
    strategy: "strategy",
    checkpointing: "checkpointing",
    micro_batch: "micro-batch",
};

type Setup = NonNullable<JobDetail["setup"]>;
type Training = NonNullable<Setup["training"]>;

function idOf(value: string | undefined): number | null {
    const id = Number(value);
    return value && Number.isInteger(id) && id > 0 ? id : null;
}

function sectionOf(kind: string | undefined, pathname: string) {
    const training = kind ? kind === TRAIN_KIND : pathname.startsWith(`${TRAINING_PATH}/`);
    return training
        ? { label: "Training", href: TRAINING_PATH }
        : { label: "Jobs", href: JOBS_PATH };
}

function versionName(job: JobDetail): string {
    return job.version === null || job.version === undefined ? "" : `v${job.version}`;
}

function modelLabel(job: JobDetail): string {
    return job.model_name ?? job.model ?? job.base_model_name ?? job.base_model ?? "Deleted model";
}

function baseLabel(job: JobDetail): string {
    const name = job.base_model_name ?? job.base_model ?? "a base model";
    return job.variant ? `${name} · ${job.variant}` : name;
}

function Subject({ job }: { job: JobDetail }) {
    if (job.model || job.deleted) {
        const version = versionName(job);
        if (job.deleted || !job.model) {
            return <ModelName name={`${modelLabel(job)} ${version}`.trim()} deleted />;
        }
        const model = (
            <Link href={modelPageHref(job.model)} className={LINK}>
                {modelLabel(job)}
            </Link>
        );
        if (job.kind === TRAIN_KIND && version) {
            return (
                <>
                    {model}
                    {" → "}
                    <Link href={modelPageHref(job.model, "versions")} className={LINK}>
                        {version}
                    </Link>
                </>
            );
        }
        return version ? (
            <Link href={modelPageHref(job.model, "versions")} className={LINK}>
                {`${modelLabel(job)} ${version}`}
            </Link>
        ) : (
            model
        );
    }
    if (job.base_model) {
        return (
            <Link href={modelPageHref(job.base_model)} className={LINK}>
                {baseLabel(job)}
            </Link>
        );
    }
    return <>the model catalogue</>;
}

function Context({ job }: { job: JobDetail }) {
    const moment = job.started_at ?? job.created_at;
    return (
        <span>
            {`${kindVerb(job.kind)} `}
            <Subject job={job} />
            {` · ${job.started_at ? "started" : "queued"} ${relativeTime(moment)}`}
        </span>
    );
}

function MoreActions({ job }: { job: JobDetail }) {
    const router = useRouter();
    const client = useQueryClient();
    const toast = useToast();
    const [deleting, setDeleting] = useState<JobDetail[] | null>(null);
    const refusal = deleteRefusal(job);
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon"
                        aria-label={`More actions for job #${job.id}`}
                    >
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuItem
                        variant="destructive"
                        disabled={refusal !== null}
                        className={refusal ? "items-start [&>svg]:mt-0.5" : undefined}
                        onSelect={() => setDeleting([job])}
                    >
                        <Trash2 />
                        <span className="flex flex-col">
                            <span>Delete job</span>
                            {refusal && (
                                <span className="text-sm whitespace-normal text-muted-foreground">
                                    {refusal}
                                </span>
                            )}
                        </span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <DeleteJobsDialog
                chosen={deleting}
                onOpenChange={(open) => !open && setDeleting(null)}
                onDeleted={async (results) => {
                    toast(deleteSummary(results));
                    router.history.push(sectionOf(job.kind, "").href);
                    await client.invalidateQueries({ queryKey: ["jobs"] });
                }}
            />
        </>
    );
}

function Actions({ job }: { job: JobDetail }) {
    const can = useCan();
    const router = useRouter();
    const client = useQueryClient();
    const target = { params: { path: { job_id: job.id } } };
    const cancel = useMutation({
        mutationFn: () => unwrap(api.POST("/api/jobs/{job_id}/cancel", target)),
        onSuccess: () => client.invalidateQueries({ queryKey: ["jobs"] }),
    });
    const retry = useMutation({
        mutationFn: () => unwrap(api.POST("/api/jobs/{job_id}/retry", target)),
        onSuccess: (again) => {
            client.invalidateQueries({ queryKey: ["jobs"] });
            router.history.push(jobHref(again));
        },
    });
    if (!can.build) {
        return null;
    }
    return (
        <>
            <ErrorLine error={cancel.error ?? retry.error} />
            {canCancel(job) && (
                <Button
                    variant="outline"
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate()}
                >
                    Cancel
                </Button>
            )}
            {canRetry(job) && (
                <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
                    Retry
                </Button>
            )}
            <MoreActions job={job} />
        </>
    );
}

function Summary({ job }: { job: JobDetail }) {
    return (
        <div className="flex flex-wrap gap-x-10 gap-y-3">
            <Stat label="Kind" value={kindNoun(job.kind)} />
            <Stat label="Status" value={<JobState job={job} />} />
            <Stat label="Attempt" value={`${Math.max(1, job.attempt)} of ${job.max_attempts}`} />
            {job.device && (
                <Stat
                    label="Device"
                    value={<span className="font-mono font-normal">{job.device}</span>}
                />
            )}
            <Stat
                label={job.finished_at || !job.started_at ? "Duration" : "Running for"}
                value={jobDuration(job)}
            />
        </div>
    );
}

function Failure({ job }: { job: JobDetail }) {
    if (!job.error || job.status === "succeeded") {
        return null;
    }
    const retrying = job.status === "queued";
    return (
        <div
            className={
                retrying
                    ? "rounded-md border border-warning/40 bg-warning-soft px-3 py-2"
                    : "rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2"
            }
        >
            <span className="font-semibold">{retrying ? "Retrying after: " : "Failed: "}</span>
            {job.error}
        </div>
    );
}

function Serving({ job }: { job: JobDetail }) {
    if (!job.live || !job.model) {
        return null;
    }
    return (
        <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
            <StatusText tone="success">Serving</StatusText>
            <span>{`${versionName(job)} is the live version of ${modelLabel(job)}.`}</span>
            <Link href={modelPageHref(job.model, "api")} className={LINK}>
                Call it
            </Link>
        </div>
    );
}

function Figure({ children }: { children: ReactNode }) {
    return <span className="tabular-nums">{children}</span>;
}

function settingsText(training: Training): string {
    const adapter = training.strategy
        ? (STRATEGIES[training.strategy] ?? training.strategy)
        : "LoRA";
    const parts = [
        training.rank ? `${adapter} rank ${training.rank}` : adapter,
        training.epochs === null || training.epochs === undefined
            ? null
            : `${training.epochs} ${training.epochs === 1 ? "epoch" : "epochs"}`,
        training.learning_rate ? `rate ${training.learning_rate.toExponential(0)}` : null,
        training.batch ? `batch ${training.batch}` : null,
        training.precision ? training.precision.toUpperCase() : null,
    ];
    return parts.filter(Boolean).join(" · ");
}

function changedText(training: Training): string {
    if (!training.planned && training.changed.length === 0) {
        return "The install defaults; the worker fits batch and memory when the run starts.";
    }
    if (training.changed.length === 0) {
        return "The install defaults.";
    }
    const names = training.changed.map((name) => SETTING_NAMES[name] ?? name);
    return `Changed from the defaults: ${names.join(", ")}.`;
}

function dataFacts(setup: Setup): Fact[] {
    if (!setup.dataset) {
        return [];
    }
    const label = setup.dataset_version
        ? `${setup.dataset} v${setup.dataset_version}`
        : setup.dataset;
    return [
        [
            "Data",
            <span key="data">
                <Link
                    href={`/data?item=${encodeURIComponent(`dataset:${setup.dataset}`)}`}
                    className={LINK}
                >
                    {label}
                </Link>
                {setup.dataset_rows ? (
                    <Figure>{` · ${count(setup.dataset_rows)} rows`}</Figure>
                ) : null}
            </span>,
        ],
    ];
}

function trainingRows(training: Training): Fact[] {
    if (training.examples === null || training.examples === undefined) {
        return [];
    }
    const held =
        training.held_out === null || training.held_out === undefined
            ? ""
            : ` · ${count(training.held_out)} held out`;
    return [
        ["Training rows", <Figure key="rows">{`${count(training.examples)} train${held}`}</Figure>],
    ];
}

function methodText(job: JobDetail, setup: Setup): string {
    if (job.kind === TRAIN_KIND) {
        return "Supervised fine-tuning (SFT)";
    }
    if (job.kind === "judge") {
        return "A judge model scores each answer from 1 to 5 with a reason";
    }
    return setup.version_kind === "prompt"
        ? "Instructions only on the base, scored"
        : "The trained adapter on its base, scored";
}

function versionFacts(job: JobDetail, setup: Setup): Fact[] {
    const facts: Fact[] = [];
    const version = versionName(job);
    if (version) {
        facts.push([
            job.kind === TRAIN_KIND ? "Produces" : "Version",
            job.model && !job.deleted ? (
                <Link
                    key="version"
                    href={
                        job.version === null
                            ? modelPageHref(job.model, "versions")
                            : modelVersionHref(job.model, job.version)
                    }
                    className={LINK}
                >
                    {`${version} of ${modelLabel(job)}`}
                </Link>
            ) : (
                `${version} of ${modelLabel(job)}`
            ),
        ]);
    }
    facts.push(...dataFacts(setup));
    if (setup.base_model) {
        facts.push([
            "Base",
            <Link key="base" href={modelPageHref(setup.base_model)} className={LINK}>
                {setup.base_model_name ?? setup.base_model}
            </Link>,
        ]);
    }
    facts.push(["Method", methodText(job, setup)]);
    const training = setup.training;
    if (training) {
        facts.push([
            "Settings",
            <span key="settings">
                <Figure>{settingsText(training)}</Figure>
                <span className="block text-sm text-muted-foreground">{changedText(training)}</span>
            </span>,
        ]);
        if (training.seq_len) {
            facts.push([
                "Sequence length",
                <Figure key="seq">{`${count(training.seq_len)} tokens`}</Figure>,
            ]);
        }
        facts.push(...trainingRows(training));
    }
    return facts;
}

function baseFacts(job: JobDetail, setup: Setup): Fact[] {
    const facts: Fact[] = [];
    if (setup.base_model) {
        facts.push([
            "Model",
            <Link key="model" href={modelPageHref(setup.base_model)} className={LINK}>
                {setup.base_model_name ?? setup.base_model}
            </Link>,
        ]);
    }
    if (setup.variant) {
        facts.push(["Variant", setup.variant]);
    }
    if (setup.revision) {
        facts.push([
            "Revision",
            <span key="revision" className="font-mono text-sm">
                {setup.revision.slice(0, 12)}
            </span>,
        ]);
    }
    if (setup.size_bytes) {
        facts.push(["Size", <Figure key="size">{bytes(setup.size_bytes)}</Figure>]);
    }
    if (BASE_KINDS.includes(job.kind)) {
        facts.push(["Checks", "Every file's SHA-256 against the expected hash"]);
    }
    return facts;
}

function setupFacts(job: JobDetail): Fact[] {
    const setup = job.setup;
    if (!setup) {
        return [];
    }
    return MODEL_JOB_KINDS.includes(job.kind) ? versionFacts(job, setup) : baseFacts(job, setup);
}

function SettingsSection({ job }: { job: JobDetail }) {
    const facts = setupFacts(job);
    return (
        <PanelSection
            icon={SlidersHorizontal}
            title="Settings and data"
            tip="What this job read and the settings it ran with."
        >
            {facts.length > 0 ? (
                <Facts items={facts} />
            ) : (
                <p>
                    <Context job={job} />
                </p>
            )}
        </PanelSection>
    );
}

function JobView({ job }: { job: JobDetail }) {
    const metrics = useJobMetrics(job.id, isActiveJob(job));
    const training = job.kind === TRAIN_KIND;
    return (
        <>
            <PageHeader
                title={`Job #${job.id}`}
                caption={<Context job={job} />}
                actions={<Actions job={job} />}
            />
            <Summary job={job} />
            <Failure job={job} />
            <Serving job={job} />
            <ErrorLine error={metrics.error} />
            <PanelSections>
                <div className="grid items-start gap-x-6 gap-y-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                    <ProgressSection job={job} metrics={metrics.data} />
                    <SettingsSection job={job} />
                </div>
                {training && <LossSection job={job} metrics={metrics.data} />}
                {training && <RateSection metrics={metrics.data} />}
                {job.kind === "eval" && <ScoresSection job={job} />}
                <JobLogsSection key={job.id} job={job} />
            </PanelSections>
        </>
    );
}

function useCanonical(job: JobDetail | undefined, pathname: string) {
    const router = useRouter();
    const canonical = job ? jobHref(job) : null;
    const here = pathname.replace(/\/+$/, "");
    const onJobPage = idOf(here.split("/").pop()) !== null;
    useEffect(() => {
        if (canonical && onJobPage && here !== canonical) {
            router.history.replace(canonical);
        }
    }, [canonical, here, onJobPage, router]);
}

export function JobPage() {
    const { id } = useParams({ strict: false }) as { id?: string };
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const jobId = idOf(id);
    const job = useJob(jobId);
    useCanonical(job.data, pathname);
    const section = sectionOf(job.data?.kind, pathname);
    return (
        <Page>
            <Breadcrumbs items={[section, { label: `Job #${id ?? ""}` }]} />
            {jobId === null && <p className="text-muted-foreground">No job called {id}.</p>}
            <ErrorLine error={job.error} />
            {job.data && <JobView job={job.data} />}
        </Page>
    );
}
