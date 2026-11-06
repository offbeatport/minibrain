import type { ColumnDef } from "@tanstack/react-table";
import { DataGrid, Link } from "obp-ui";
import type { JobInfo } from "~/api/client";
import { useModels, useRecentJobs } from "~/api/queries";
import { ModelName } from "~/components/ModelName";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section, Stat } from "~/components/Section";
import { JobStatus } from "~/components/StatusBadge";
import { count, dateTime, percent } from "~/lib/format";
import { jobHref } from "~/lib/modelLinks";

const JOB_COLUMNS: ColumnDef<JobInfo, unknown>[] = [
    {
        header: "Model",
        id: "model",
        cell: ({ row }) => (
            <Link className="text-primary" href={jobHref(row.original)}>
                <ModelName
                    name={row.original.model_name ?? row.original.base_model ?? "Install"}
                    deleted={row.original.deleted}
                />
            </Link>
        ),
    },
    {
        header: "Job",
        id: "job",
        cell: ({ row }) =>
            `${row.original.kind === "train" ? "Training" : "Scoring"} v${row.original.version}`,
    },
    { header: "Status", id: "status", cell: ({ row }) => <JobStatus job={row.original} /> },
    { header: "Progress", id: "progress", cell: ({ row }) => percent(row.original.progress) },
    { header: "Created", id: "created", cell: ({ row }) => dateTime(row.original.created_at) },
];

function GetStarted() {
    return (
        <Section title="Get started" caption="Five minutes with the sample data in this repo.">
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
                <li>
                    Create a model on{" "}
                    <Link className="text-primary" href="/models">
                        Models
                    </Link>
                    .
                </li>
                <li>
                    On Data, upload <span className="font-mono">samples/travel_intents.jsonl</span>{" "}
                    and build the dataset.
                </li>
                <li>
                    On Training, pick it as the model's data; the model page then offers to restrict
                    its answers to the labels it holds.
                </li>
                <li>On Training, score a prompt-only version, then train one.</li>
                <li>
                    Compare them on Evaluations, promote the better one and call it from
                    Deployments.
                </li>
            </ol>
        </Section>
    );
}

export function HomePage() {
    const { data: models } = useModels();
    const { data: jobs } = useRecentJobs(10);
    const serving = (models ?? []).filter((item) => item.current_version !== null).length;
    const running = (models ?? []).reduce((total, item) => total + item.active_jobs, 0);
    return (
        <Page>
            <PageHeader
                title="Home"
                caption="Models of any size, trained on your data and served on an OpenAI-compatible endpoint. Everything runs on your own hardware."
            />
            <Section title="Overview">
                <div className="flex flex-wrap gap-8">
                    <Stat label="Models" value={count(models?.length)} />
                    <Stat label="Serving" value={count(serving)} />
                    <Stat label="Jobs running" value={count(running)} />
                </div>
            </Section>
            {models?.length === 0 && <GetStarted />}
            <Section title="Recent jobs" flush>
                <DataGrid columns={JOB_COLUMNS} rows={jobs ?? []} empty="No jobs yet." />
            </Section>
        </Page>
    );
}
