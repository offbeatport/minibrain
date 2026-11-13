import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { Button, DataGrid, Link, Tooltip, TooltipContent, TooltipTrigger, useToast } from "obp-ui";
import { useState } from "react";
import { type FeedbackInfo, useRemoveTestExample, useTestExamples } from "~/api/feedbackQueries";
import { ErrorLine, errorMessage } from "~/components/Section";
import { feedbackHref } from "~/lib/feedback";
import { relativeTime } from "~/lib/time";
import { ConfirmAction, type Confirmation } from "~/pages/models/dialogs";

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
    const toast = useToast();
    const examples = useTestExamples(slug);
    const remove = useRemoveTestExample(slug);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const ask = (item: FeedbackInfo) =>
        setConfirmation({
            title: "Remove this test example?",
            description: (
                <p>
                    The next version is not scored on it. Versions already scored keep their rows.
                </p>
            ),
            confirmLabel: "Remove",
            destructive: true,
            run: () =>
                remove.mutateAsync(item.id).then(
                    () => toast({ title: "Test example removed", tone: "success" }),
                    (error) =>
                        toast({
                            title: "Not removed",
                            description: errorMessage(error),
                            tone: "destructive",
                        }),
                ),
        });
    return (
        <div className="flex flex-col gap-2">
            <DataGrid
                columns={COLUMNS}
                rows={examples.data ?? []}
                loading={examples.isLoading}
                getRowId={(item) => String(item.id)}
                onOpen={(item) => router.history.push(feedbackHref(item.id))}
                rowLabel={(item) => `Test example ${lastMessage(item)}`}
                rowActions={(item) => (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove test example ${lastMessage(item)}`}
                                onClick={() => ask(item)}
                            >
                                <Trash2 aria-hidden="true" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Remove</TooltipContent>
                    </Tooltip>
                )}
                empty="No test examples yet. Add one, or use Save as test example on an answer in the Playground."
            />
            <ErrorLine error={examples.error} onRetry={examples.refetch} />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </div>
    );
}
