import { useMutation } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    FileTypeIcon,
    Label,
    RadioGroup,
    RadioGroupItem,
} from "obp-ui";
import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
    type NameTaken,
    type NameTakenInfo,
    type SourceAdded,
    type SourceSummary,
    api,
    unwrap,
    uploadFile,
} from "~/api/client";
import { useDatasets, useSamples, useSources } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { DATA_FILE_TYPES } from "~/lib/dataFiles";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import { type SourceGroupId, plural } from "./catalogue";
import { GroupIcon, SourceIcon } from "./icons";
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
    drop: (files: File[]) => void;
    addSample: (file: string) => void;
    pending: "upload" | "sample" | null;
    error: unknown;
    picker: ReactNode;
};

type Question = { file: File; taken: NameTakenInfo };

type Choice = Exclude<NameTaken, "fail">;

function NameTakenDialog({
    question,
    pending,
    error,
    onCancel,
    onChoose,
}: {
    question: Question | null;
    pending: boolean;
    error: unknown;
    onCancel: () => void;
    onChoose: (choice: Choice) => void;
}) {
    const sources = useSources();
    const datasets = useDatasets();
    const [choice, setChoice] = useState<Choice>("keep_both");
    const asked = question?.taken.taken ?? null;
    useEffect(() => {
        if (asked !== null) {
            setChoice("keep_both");
        }
    }, [asked]);
    const existing = (sources.data ?? []).find((source) => source.id === asked);
    const name = question?.taken.name ?? "";
    const replaceable = existing?.kind === "upload";
    const readers = (existing?.datasets ?? []).map(
        (slug) => datasets.data?.find((dataset) => dataset.slug === slug)?.name ?? slug,
    );
    const effect =
        readers.length === 0
            ? " No dataset reads it yet."
            : ` ${readers.length === 1 ? "The dataset" : "The datasets"} ${readers.join(", ")} will say ${readers.length === 1 ? "its" : "their"} sources changed, and Update saves a new version.`;
    return (
        <Dialog open={question !== null} onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className="sm:max-w-lg">
                <form
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        onChoose(choice);
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>
                            {replaceable
                                ? `${name} is already uploaded`
                                : `A source called ${name} already exists`}
                        </DialogTitle>
                        <DialogDescription>
                            {`The file you picked${question ? ` (${bytes(question.file.size)})` : ""} has different content. Replace the uploaded one, or keep both.`}
                        </DialogDescription>
                    </DialogHeader>
                    <RadioGroup
                        value={choice}
                        onValueChange={(next) =>
                            setChoice(next === "replace" && replaceable ? "replace" : "keep_both")
                        }
                        aria-label="What to do with the new file"
                        className="gap-3"
                    >
                        <Label className="flex items-start gap-2 font-normal">
                            <RadioGroupItem value="keep_both" className="mt-0.5" />
                            <span className="flex flex-col gap-0.5">
                                <span className="font-medium">Keep both</span>
                                <span className="text-sm text-muted-foreground">
                                    {`The new file is added as ${question?.taken.suggestion ?? ""}, with a table of its own.`}
                                </span>
                            </span>
                        </Label>
                        <Label className="flex items-start gap-2 font-normal">
                            <RadioGroupItem
                                value="replace"
                                disabled={!replaceable}
                                className="mt-0.5"
                            />
                            <span className="flex flex-col gap-0.5">
                                <span className="font-medium">Replace</span>
                                <span className="text-sm text-muted-foreground">
                                    {replaceable ? (
                                        <>
                                            {`${name} reads the new file. Its table stays `}
                                            <span className="font-mono">{existing?.table}</span>
                                            {`, so dataset SQL keeps working.${effect}`}
                                        </>
                                    ) : (
                                        `${name} is not an uploaded file, so a file cannot replace it.`
                                    )}
                                </span>
                            </span>
                        </Label>
                    </RadioGroup>
                    <ErrorLine error={error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onCancel}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={pending}>
                            {pending
                                ? "Uploading…"
                                : choice === "replace"
                                  ? "Replace"
                                  : "Keep both"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function useSourceAdder(onAdded: (source: SourceAdded) => void): SourceAdder {
    const refresh = useDataRefresh();
    const input = useRef<HTMLInputElement>(null);
    const [question, setQuestion] = useState<Question | null>(null);
    const added = async (source: SourceAdded) => {
        await refresh();
        onAdded(source);
    };
    const upload = useMutation({
        mutationFn: ({ file, nameTaken }: { file: File; nameTaken: NameTaken }) =>
            uploadFile(file, nameTaken),
        onSuccess: async (result, { file }) => {
            if (result.outcome === "name_taken") {
                setQuestion({ file, taken: result.taken });
                return;
            }
            setQuestion(null);
            await added(result);
        },
    });
    const sample = useMutation({
        mutationFn: (file: string) =>
            unwrap(api.POST("/api/samples/{file}", { params: { path: { file } } })),
        onSuccess: added,
    });
    const send = (file: File | undefined) => {
        if (file && !upload.isPending) {
            upload.mutate({ file, nameTaken: "fail" });
        }
    };
    const choose = (event: ChangeEvent<HTMLInputElement>) => {
        send(event.target.files?.[0]);
        event.target.value = "";
    };
    return {
        choose: () => input.current?.click(),
        drop: (files) => send(files[0]),
        addSample: (file) => sample.mutate(file),
        pending: upload.isPending ? "upload" : sample.isPending ? "sample" : null,
        error: (question ? null : upload.error) ?? sample.error,
        picker: (
            <>
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
                <NameTakenDialog
                    question={question}
                    pending={upload.isPending}
                    error={question ? upload.error : null}
                    onCancel={() => {
                        setQuestion(null);
                        upload.reset();
                    }}
                    onChoose={(choice) =>
                        question && upload.mutate({ file: question.file, nameTaken: choice })
                    }
                />
            </>
        ),
    };
}

const ALREADY: Record<SourceSummary["kind"], string> = {
    upload: "This file is already uploaded",
    folder: "This folder is already added",
    s3: "This S3 path is already added",
    database: "This table is already added",
    iceberg: "This Iceberg table is already added",
    delta: "This Delta table is already added",
};

export function alreadyText(source: SourceSummary): string {
    const what =
        source.kind === "database" && source.query
            ? "This query is already added"
            : ALREADY[source.kind];
    return `${what} as ${source.name}.`;
}

export function AlreadyAddedDialog({
    source,
    onOpenChange,
    onOpen,
}: {
    source: SourceSummary | null;
    onOpenChange: (open: boolean) => void;
    onOpen: (source: SourceSummary) => void;
}) {
    const upload = source?.kind === "upload";
    return (
        <Dialog open={source !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{upload ? "Already uploaded" : "Already added"}</DialogTitle>
                    <DialogDescription>
                        {source
                            ? `${alreadyText(source)} ${upload ? "Each file is stored once and is one source" : "Each location is one source"}, so every dataset that reads these rows reads the same table.`
                            : ""}
                    </DialogDescription>
                </DialogHeader>
                {source && (
                    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                        <SourceIcon source={source} className="size-4 shrink-0" />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-medium">{source.name}</span>
                            <span className="truncate text-sm text-muted-foreground tabular-nums">
                                {"Table "}
                                <span className="font-mono">{source.table}</span>
                                {source.rows === null ? "" : ` · ${plural(source.rows, "row")}`}
                                {source.datasets.length > 0
                                    ? ` · read by ${plural(source.datasets.length, "dataset")}`
                                    : ""}
                            </span>
                        </span>
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        onClick={() => {
                            if (source) {
                                onOpen(source);
                            }
                            onOpenChange(false);
                        }}
                    >
                        {`Open ${source?.name ?? ""}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
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
