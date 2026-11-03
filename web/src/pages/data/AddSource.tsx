import { useMutation } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "obp-ui";
import { type ChangeEvent, useRef } from "react";
import { type SourceSummary, uploadFile } from "~/api/client";
import { ErrorLine } from "~/components/Section";
import { DATA_FILE_TYPES } from "~/lib/dataFiles";
import { useDataRefresh } from "./parts";

export type AddKind = "folder" | "s3" | "database" | "iceberg";

const CHOICES: { kind: AddKind; label: string; detail: string }[] = [
    { kind: "folder", label: "Connect a folder", detail: "Files on this server, read in place" },
    { kind: "s3", label: "S3 path", detail: "Objects in a bucket, read in place" },
    {
        kind: "database",
        label: "Database table or query",
        detail: "PostgreSQL or MySQL, read-only",
    },
    { kind: "iceberg", label: "Iceberg table", detail: "A table on S3, at its current snapshot" },
];

export function AddSourceMenu({
    onUploaded,
    onAdd,
}: {
    onUploaded: (source: SourceSummary) => void;
    onAdd: (kind: AddKind) => void;
}) {
    const refresh = useDataRefresh();
    const input = useRef<HTMLInputElement>(null);
    const upload = useMutation({
        mutationFn: uploadFile,
        onSuccess: async (source) => {
            await refresh();
            onUploaded(source);
        },
    });
    const choose = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            upload.mutate(file);
        }
        event.target.value = "";
    };
    return (
        <div className="flex flex-col items-end gap-1">
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button disabled={upload.isPending}>
                        {upload.isPending ? "Uploading…" : "Add source"}
                        <ChevronDown />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                    <DropdownMenuItem
                        onSelect={() => input.current?.click()}
                        className="flex-col items-start gap-0.5"
                    >
                        <span className="font-medium">Upload a file</span>
                        <span className="text-sm text-muted-foreground">
                            CSV, TSV, JSON Lines or Parquet, copied in
                        </span>
                    </DropdownMenuItem>
                    {CHOICES.map((choice) => (
                        <DropdownMenuItem
                            key={choice.kind}
                            onSelect={() => onAdd(choice.kind)}
                            className="flex-col items-start gap-0.5"
                        >
                            <span className="font-medium">{choice.label}</span>
                            <span className="text-sm text-muted-foreground">{choice.detail}</span>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            <input
                ref={input}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-label="Data file to upload"
                accept={DATA_FILE_TYPES}
                onChange={choose}
                disabled={upload.isPending}
            />
            <ErrorLine error={upload.error} />
        </div>
    );
}
