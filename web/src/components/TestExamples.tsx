import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { DataGrid, Link } from "obp-ui";
import { type FeedbackInfo, useTestExamples } from "~/api/feedbackQueries";
import { ErrorLine } from "~/components/Section";
import { feedbackHref } from "~/lib/feedback";
import { relativeTime } from "~/lib/time";

function lastMessage(item: FeedbackInfo): string {
    return item.messages?.at(-1)?.content ?? item.input;
}

const COLUMNS: ColumnDef<FeedbackInfo, unknown>[] = [
    {
        id: "conversation",
        header: "Conversation",
        enableHiding: false,
        cell: ({ row }) => (
            <Link
                href={feedbackHref(row.original.id)}
                className="block max-w-80 truncate font-semibold text-foreground"
            >
                {lastMessage(row.original)}
            </Link>
        ),
    },
    {
        id: "expected",
        header: "Expected answer",
        cell: ({ row }) => <span className="block max-w-48 truncate">{row.original.label}</span>,
    },
    {
        id: "answer",
        header: "Model's answer",
        cell: ({ row }) => (
            <span className="block max-w-48 truncate">
                {row.original.output ?? <span className="text-muted-foreground">Not sent</span>}
            </span>
        ),
    },
    {
        id: "version",
        header: "Found on",
        cell: ({ row }) => (
            <span className="tabular-nums">
                {row.original.version === null ? "–" : `v${row.original.version}`}
            </span>
        ),
    },
    {
        id: "saved",
        header: "Saved",
        cell: ({ row }) => (
            <span className="block max-w-56 truncate">
                {`${relativeTime(row.original.reviewed_at ?? row.original.created_at)} by ${row.original.reviewed_by ?? "someone"}`}
            </span>
        ),
    },
];

export function TestExamples({ slug }: { slug: string }) {
    const router = useRouter();
    const examples = useTestExamples(slug);
    return (
        <div className="flex flex-col gap-2">
            <DataGrid
                columns={COLUMNS}
                rows={examples.data ?? []}
                loading={examples.isLoading}
                getRowId={(item) => String(item.id)}
                onOpen={(item) => router.history.push(feedbackHref(item.id))}
                rowLabel={(item) => `Test example ${lastMessage(item)}`}
                empty="No test examples yet. In the Playground, use Save as test example on an answer from this model."
            />
            <ErrorLine error={examples.error} onRetry={examples.refetch} />
        </div>
    );
}
