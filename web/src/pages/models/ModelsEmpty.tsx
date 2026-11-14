import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Boxes } from "lucide-react";
import { Button, useToast } from "obp-ui";
import { api, unwrap } from "~/api/client";
import { errorMessage } from "~/components/Section";
import { bytes } from "~/lib/time";
import { modelHref } from "../data/parts";
import { useModelsRefresh } from "./dialogs";

export function ModelsEmpty() {
    const refresh = useModelsRefresh();
    const router = useRouter();
    const toast = useToast();
    const sample = useMutation({
        mutationFn: () => unwrap(api.POST("/api/models/sample")),
        onSuccess: async (created) => {
            await refresh();
            const rows = `${created.name}: ${created.dataset_version?.rows ?? 0} sample messages`;
            const scored =
                created.download_bytes === null
                    ? `Version 0 on ${created.base_name} is being scored`
                    : `Downloading ${created.base_name} (${bytes(created.download_bytes)}); version 0 is scored once it is here`;
            toast({
                title: "Sample model added",
                description: `${rows}. ${scored}. Its answers look like labels: open it to restrict them.`,
                tone: "success",
                action: {
                    label: "Open",
                    onClick: () => router.history.push(modelHref(created.slug)),
                },
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
                    Create a model from a base and your data, or try one with demo data.
                </p>
            </div>
            <Button
                type="button"
                variant="outline"
                disabled={sample.isPending}
                onClick={() => sample.mutate()}
            >
                {sample.isPending ? "Adding demo data…" : "Try with demo data"}
            </Button>
        </div>
    );
}
