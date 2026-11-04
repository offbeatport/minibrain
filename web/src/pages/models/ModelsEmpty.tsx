import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, Link, useToast } from "obp-ui";
import { api, unwrap } from "~/api/client";
import { errorMessage } from "~/components/Section";
import { useModelsRefresh } from "./dialogs";

const STEPS = [
    {
        title: "Pick a base model",
        text: "From the catalogue, one you already have, or an import.",
    },
    {
        title: "Add your data",
        text: "Upload a file or connect a database, then map inputs to labels.",
    },
    {
        title: "Train and serve",
        text: "Compare versions on held-out rows and deploy the best one.",
    },
];

export function ModelsEmpty() {
    const refresh = useModelsRefresh();
    const toast = useToast();
    const sample = useMutation({
        mutationFn: () => unwrap(api.POST("/api/minibrains/sample")),
        onSuccess: async (created) => {
            await refresh();
            toast({
                title: "Sample added",
                description: `${created.name} comes with its data, ready to train.`,
                tone: "success",
            });
        },
        onError: (error) =>
            toast({
                title: "The sample was not added",
                description: errorMessage(error),
                tone: "destructive",
            }),
    });
    return (
        <div className="flex w-full max-w-3xl flex-col items-center gap-8 py-10">
            <div className="flex flex-col items-center gap-2">
                <h2 className="text-xl font-semibold">No models yet</h2>
                <p className="max-w-lg text-base text-muted-foreground">
                    A model starts from a base model, learns from your data, and serves an
                    OpenAI-compatible endpoint on your own hardware.
                </p>
            </div>
            <ol className="grid w-full gap-3 text-left sm:grid-cols-3">
                {STEPS.map((step, index) => (
                    <li key={step.title} className="flex gap-3 rounded-lg border bg-background p-4">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md border font-mono text-sm tabular-nums">
                            {index + 1}
                        </span>
                        <span className="flex flex-col gap-0.5">
                            <span className="text-sm font-medium">{step.title}</span>
                            <span className="text-sm text-muted-foreground">{step.text}</span>
                        </span>
                    </li>
                ))}
            </ol>
            <div className="flex flex-wrap items-center justify-center gap-2">
                <Button asChild>
                    <Link href="/models/new">
                        <Plus />
                        Add model
                    </Link>
                </Button>
                <Button asChild variant="outline">
                    <Link href="/discover">Browse the catalogue</Link>
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    disabled={sample.isPending}
                    onClick={() => sample.mutate()}
                >
                    {sample.isPending ? "Adding the sample…" : "Try the sample"}
                </Button>
            </div>
        </div>
    );
}
