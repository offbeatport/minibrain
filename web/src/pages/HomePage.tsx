import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "obp-ui";
import type { JobInfo } from "~/api/client";
import { useMinibrains, useRecentJobs } from "~/api/queries";
import { DataTable } from "~/components/DataTable";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section, Stat } from "~/components/Section";
import { JobStatus } from "~/components/StatusBadge";
import { count, dateTime, percent } from "~/lib/format";

const JOB_COLUMNS: ColumnDef<JobInfo, unknown>[] = [
    {
        header: "minibrain",
        id: "minibrain",
        cell: ({ row }) => (
            <Link
                className="text-primary"
                href={`/training?minibrain=${encodeURIComponent(row.original.minibrain)}`}
            >
                {row.original.minibrain_name}
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
                    Create a minibrain on{" "}
                    <Link className="text-primary" href="/models">
                        Models
                    </Link>
                    .
                </li>
                <li>
                    On Data, upload <span className="font-mono">samples/travel_intents.jsonl</span>{" "}
                    and build the dataset.
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
    const { data: minibrains } = useMinibrains();
    const { data: jobs } = useRecentJobs(10);
    const serving = (minibrains ?? []).filter((item) => item.current_version !== null).length;
    const running = (minibrains ?? []).reduce((total, item) => total + item.active_jobs, 0);
    return (
        <Page>
            <PageHeader
                title="Home"
                caption="Small models trained on your data and served on an OpenAI-compatible endpoint. Everything runs on this machine."
            />
            <Section title="Overview">
                <div className="flex flex-wrap gap-8">
                    <Stat label="Minibrains" value={count(minibrains?.length)} />
                    <Stat label="Serving" value={count(serving)} />
                    <Stat label="Jobs running" value={count(running)} />
                </div>
            </Section>
            {minibrains?.length === 0 && <GetStarted />}
            <Section title="Recent jobs">
                <DataTable columns={JOB_COLUMNS} rows={jobs ?? []} empty="No jobs yet." />
            </Section>
        </Page>
    );
}
