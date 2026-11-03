import { useMutation } from "@tanstack/react-query";
import { Button, Link, useToast } from "obp-ui";
import { type VersionInfo, api, unwrap } from "~/api/client";
import { useFeedbackSummary, useRefreshFeedback } from "~/api/feedbackQueries";
import { useVersions } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { feedbackForModel } from "~/lib/feedback";
import { count } from "~/lib/format";
import { useInvalidate } from "~/lib/jobs";

const DEFAULT_ROWS = 3000;
const DEFAULT_EPOCHS = 1;

function lastRecipe(versions: VersionInfo[]): { max_rows: number; epochs: number } {
    const trained = versions.find((version) => version.kind === "lora");
    const recipe = (trained?.recipe ?? {}) as { max_rows?: unknown; epochs?: unknown };
    return {
        max_rows: Number(recipe.max_rows) || DEFAULT_ROWS,
        epochs: Number(recipe.epochs) || DEFAULT_EPOCHS,
    };
}

function plural(total: number, noun: string): string {
    return `${count(total)} ${noun}${total === 1 ? "" : "s"}`;
}

export function FeedbackSince({ slug }: { slug: string }) {
    const toast = useToast();
    const summary = useFeedbackSummary(slug);
    const versions = useVersions(slug);
    const invalidate = useInvalidate(slug);
    const refresh = useRefreshFeedback();
    const train = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/minibrains/{slug}/versions", {
                    params: { path: { slug } },
                    body: { kind: "lora", ...lastRecipe(versions.data ?? []) },
                }),
            ),
        onSuccess: (version) => {
            toast({
                title: `Training v${version.number} with feedback`,
                description: `Its training data includes ${plural(summary.data?.rows ?? 0, "row")} from accepted feedback.`,
                tone: "success",
            });
            invalidate();
            refresh();
        },
    });
    const data = summary.data;
    if (!data) {
        return null;
    }
    const since = data.version === null ? "Feedback so far" : `Feedback since v${data.version}`;
    const waiting =
        data.pending > 0 ? ` ${plural(data.pending, "answer")} waiting for review.` : "";
    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="text-base font-semibold tabular-nums">
                        {`${since}: ${count(data.total)} (${count(data.accepted)} accepted)`}
                    </p>
                    <p className="text-sm text-muted-foreground tabular-nums">
                        {data.rows > 0
                            ? `${plural(data.rows, "accepted answer")} ${data.rows === 1 ? "joins" : "join"} the next training data.${waiting}`
                            : `No accepted answers to train on yet.${waiting}`}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" asChild>
                        <Link href={feedbackForModel(slug)}>Review feedback</Link>
                    </Button>
                    <Button
                        onClick={() => train.mutate()}
                        disabled={data.rows === 0 || train.isPending || !versions.data}
                    >
                        {train.isPending ? "Starting…" : "Train with feedback"}
                    </Button>
                </div>
            </div>
            <ErrorLine error={train.error} />
        </div>
    );
}
