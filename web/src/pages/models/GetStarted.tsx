import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Button, Card, CardContent, CardFooter } from "obp-ui";
import { api, unwrap } from "~/api/client";
import { ErrorLine } from "~/components/Section";
import { useModelsRefresh } from "./dialogs";

const STEPS = [
    {
        title: "Pick a base model",
        body: "Qwen3 0.6B is ready to train on any machine. Discover has larger ones.",
    },
    {
        title: "Add training data",
        body: "A CSV or JSONL file with a text column and a label column, or a SQL query.",
    },
    {
        title: "Train and compare",
        body: "Train a version, compare it with prompting alone, then deploy the better one.",
    },
];

export function GetStarted({
    onDiscover,
    onCreate,
}: {
    onDiscover: () => void;
    onCreate: () => void;
}) {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const sample = useMutation({
        mutationFn: () => unwrap(api.POST("/api/minibrains/sample")),
        onSuccess: async (created) => {
            await refresh();
            router.history.push(`/data?minibrain=${encodeURIComponent(created.slug)}`);
        },
    });
    return (
        <Card>
            <CardContent>
                <ol className="grid gap-4 md:grid-cols-3">
                    {STEPS.map((step, index) => (
                        <li key={step.title} className="flex gap-3">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-md border text-sm font-semibold tabular-nums">
                                {index + 1}
                            </span>
                            <span className="flex flex-col gap-0.5">
                                <span className="font-semibold">{step.title}</span>
                                <span className="text-sm text-muted-foreground">{step.body}</span>
                            </span>
                        </li>
                    ))}
                </ol>
            </CardContent>
            <CardFooter className="flex-wrap gap-2 border-t">
                <Button onClick={() => sample.mutate()} disabled={sample.isPending}>
                    {sample.isPending ? "Creating sample…" : "Try it with sample data"}
                </Button>
                <Button variant="outline" onClick={onCreate}>
                    Add model
                </Button>
                <Button variant="ghost" onClick={onDiscover}>
                    Discover base models
                </Button>
                <span className="text-sm text-muted-foreground">
                    The sample sorts travel support messages into intents.
                </span>
            </CardFooter>
            {sample.error && (
                <CardContent>
                    <ErrorLine error={sample.error} />
                </CardContent>
            )}
        </Card>
    );
}
