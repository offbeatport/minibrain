import { useMutation } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { Button, useToast } from "obp-ui";
import { api, unwrap } from "~/api/client";
import { errorMessage } from "~/components/Section";
import { bytes } from "~/lib/time";
import { useModelsRefresh } from "./dialogs";

export function ModelsEmpty() {
    const refresh = useModelsRefresh();
    const toast = useToast();
    const sample = useMutation({
        mutationFn: () => unwrap(api.POST("/api/minibrains/sample")),
        onSuccess: async (created) => {
            await refresh();
            const messages = `${created.name}: ${created.source?.rows ?? 0} messages`;
            toast({
                title: "Sample added",
                description:
                    created.download_bytes === null
                        ? `${messages} on ${created.base_name}, ready to train.`
                        : `${messages}. Downloading ${created.base_name} (${bytes(created.download_bytes)}) to train it.`,
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
        <div className="flex flex-col items-center gap-4 py-10">
            <Boxes aria-hidden="true" className="size-10 text-muted-foreground" strokeWidth={1.5} />
            <div className="flex flex-col items-center gap-1">
                <h2 className="text-lg font-semibold">No models yet</h2>
                <p className="text-base text-muted-foreground">
                    Add a base model to get started, or try the sample first.
                </p>
            </div>
            <Button
                type="button"
                variant="outline"
                disabled={sample.isPending}
                onClick={() => sample.mutate()}
            >
                {sample.isPending ? "Adding sample data…" : "Try with sample data"}
            </Button>
        </div>
    );
}
