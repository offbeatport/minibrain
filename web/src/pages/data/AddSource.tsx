import { useMutation } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    FileTypeIcon,
} from "obp-ui";
import { type ChangeEvent, type ReactNode, useRef } from "react";
import { type SourceSummary, api, unwrap, uploadFile } from "~/api/client";
import { useSamples } from "~/api/queries";
import { DATA_FILE_TYPES } from "~/lib/dataFiles";
import { count } from "~/lib/format";
import type { SourceGroupId } from "./catalogue";
import { GroupIcon } from "./icons";
import { useDataRefresh } from "./parts";

export type AddKind = Exclude<SourceGroupId, "upload">;

export const SOURCE_CHOICES: { group: SourceGroupId; label: string; detail: string }[] = [
    { group: "upload", label: "Upload a file", detail: "CSV, TSV, JSON, Parquet" },
    { group: "folder", label: "Connect a folder", detail: "Files on this server" },
    { group: "s3", label: "S3 path", detail: "Objects in a bucket" },
    { group: "database", label: "Database table or query", detail: "PostgreSQL or MySQL" },
    { group: "lakehouse", label: "Lakehouse table", detail: "Iceberg, Delta Lake" },
];

export type SourceAdder = {
    choose: () => void;
    addSample: (file: string) => void;
    pending: "upload" | "sample" | null;
    error: unknown;
    picker: ReactNode;
};

export function useSourceAdder(onUploaded: (source: SourceSummary) => void): SourceAdder {
    const refresh = useDataRefresh();
    const input = useRef<HTMLInputElement>(null);
    const added = async (source: SourceSummary) => {
        await refresh();
        onUploaded(source);
    };
    const upload = useMutation({ mutationFn: uploadFile, onSuccess: added });
    const sample = useMutation({
        mutationFn: (file: string) =>
            unwrap(api.POST("/api/samples/{file}", { params: { path: { file } } })),
        onSuccess: added,
    });
    const choose = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            upload.mutate(file);
        }
        event.target.value = "";
    };
    return {
        choose: () => input.current?.click(),
        addSample: (file) => sample.mutate(file),
        pending: upload.isPending ? "upload" : sample.isPending ? "sample" : null,
        error: upload.error ?? sample.error,
        picker: (
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
        ),
    };
}

export function addSourceKind(adder: SourceAdder, onAdd: (kind: AddKind) => void) {
    return (group: SourceGroupId) => (group === "upload" ? adder.choose() : onAdd(group));
}

export function AddSourceMenu({
    adder,
    onAdd,
}: {
    adder: SourceAdder;
    onAdd: (kind: AddKind) => void;
}) {
    const samples = useSamples();
    const pick = addSourceKind(adder, onAdd);
    const label =
        adder.pending === "upload"
            ? "Uploading…"
            : adder.pending === "sample"
              ? "Adding…"
              : "Add source";
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button disabled={adder.pending !== null}>
                    {label}
                    <ChevronDown />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
                {SOURCE_CHOICES.map((choice) => (
                    <DropdownMenuItem
                        key={choice.group}
                        onSelect={() => pick(choice.group)}
                        className="items-start"
                    >
                        <GroupIcon group={choice.group} className="mt-0.5" />
                        <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="font-medium">{choice.label}</span>
                            <span className="text-sm text-muted-foreground">{choice.detail}</span>
                        </span>
                    </DropdownMenuItem>
                ))}
                {(samples.data ?? []).length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Sample data</DropdownMenuLabel>
                        {(samples.data ?? []).map((item) => (
                            <DropdownMenuItem
                                key={item.file}
                                onSelect={() => adder.addSample(item.file)}
                                className="items-start"
                            >
                                <FileTypeIcon name={item.file} className="mt-0.5" />
                                <span className="flex min-w-0 flex-col gap-0.5">
                                    <span className="font-medium">{item.name}</span>
                                    <span className="text-sm text-muted-foreground tabular-nums">
                                        {`${item.format} · ${count(item.rows)} rows · ${count(item.labels)} labels`}
                                    </span>
                                </span>
                            </DropdownMenuItem>
                        ))}
                    </>
                )}
                {samples.error ? (
                    <p className="px-2.5 py-1.5 text-sm text-destructive">
                        Sample data could not be listed.
                    </p>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
