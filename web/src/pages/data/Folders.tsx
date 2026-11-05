import { useMutation } from "@tanstack/react-query";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Field,
    FieldGroup,
    Input,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useState } from "react";
import {
    type DatasetSummary,
    type SourceAdded,
    type SourceSummary,
    api,
    unwrap,
} from "~/api/client";
import { useFolderRoots } from "~/api/dataQueries";
import { ErrorLine, Stat } from "~/components/Section";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import { usesSource } from "./catalogue";
import { useDataRefresh, useSourceNameProblem } from "./parts";

type FolderFormat = ".csv" | ".tsv" | ".json" | ".jsonl" | ".parquet";

const FORMATS: { value: FolderFormat | "auto"; label: string }[] = [
    { value: "auto", label: "The most common in the folder" },
    { value: ".csv", label: "CSV" },
    { value: ".tsv", label: "TSV" },
    { value: ".json", label: "JSON" },
    { value: ".jsonl", label: "JSON Lines" },
    { value: ".parquet", label: "Parquet" },
];

export const FORMAT_LABELS: Record<string, string> = {
    ".csv": "CSV",
    ".tsv": "TSV",
    ".json": "JSON",
    ".jsonl": "JSON Lines",
    ".parquet": "Parquet",
};

export function AddFolderDialog({
    open,
    roots,
    onOpenChange,
    onAdded,
}: {
    open: boolean;
    roots: string[];
    onOpenChange: (open: boolean) => void;
    onAdded: (source: SourceAdded) => void;
}) {
    const refresh = useDataRefresh();
    const [path, setPath] = useState("");
    const [name, setName] = useState("");
    const [format, setFormat] = useState<FolderFormat | "auto">("auto");
    const nameProblem = useSourceNameProblem(name);
    const add = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/sources/folders", {
                    body: {
                        path: path.trim(),
                        name: name.trim() || null,
                        format: format === "auto" ? null : format,
                    },
                }),
            ),
        onSuccess: async (source) => {
            await refresh();
            onOpenChange(false);
            setPath("");
            setName("");
            setFormat("auto");
            onAdded(source);
        },
    });
    if (roots.length === 0) {
        return (
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>No folders allowed yet</DialogTitle>
                        <DialogDescription>
                            For safety, minibrain only reads folders an admin allows under Settings,
                            Security, Folder sources.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button asChild>
                            <Link href="/settings/security">Open security settings</Link>
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <form
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!nameProblem) {
                            add.mutate();
                        }
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Add a folder</DialogTitle>
                        <DialogDescription>
                            minibrain reads the files where they are, as one table, each time a
                            query runs. Nothing is copied until a dataset saves a version.
                        </DialogDescription>
                    </DialogHeader>
                    <FieldGroup>
                        <Field
                            id="folder-path"
                            label="Folder on this server"
                            hint={`Inside ${roots.join(", ")}.`}
                        >
                            <Input
                                id="folder-path"
                                value={path}
                                className="font-mono"
                                placeholder={roots[0] ? `${roots[0]}/exports` : "/data/exports"}
                                onChange={(event) => setPath(event.target.value)}
                            />
                        </Field>
                        <Field
                            id="folder-name"
                            label="Name"
                            hint="The folder's name if empty; a taken one gets a number."
                            error={nameProblem}
                        >
                            <Input
                                id="folder-name"
                                value={name}
                                maxLength={120}
                                aria-invalid={nameProblem ? true : undefined}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </Field>
                        <Field id="folder-format" label="Files to read">
                            <Select
                                value={format}
                                onValueChange={(next) =>
                                    setFormat((next ?? "auto") as FolderFormat | "auto")
                                }
                            >
                                <SelectTrigger id="folder-format" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {FORMATS.map((item) => (
                                        <SelectItem key={item.value} value={item.value}>
                                            {item.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                    </FieldGroup>
                    <ErrorLine error={add.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={!path.trim() || !!nameProblem || add.isPending}
                        >
                            {add.isPending ? "Reading…" : "Add folder"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function FoldersGroup({
    sources,
    datasets,
    onAdded,
}: {
    sources: SourceSummary[];
    datasets: DatasetSummary[];
    onAdded: (source: SourceAdded) => void;
}) {
    const roots = useFolderRoots();
    const [adding, setAdding] = useState(false);
    const members = sources.filter((source) => source.kind === "folder");
    const used = datasets.filter((dataset) =>
        members.some((source) => usesSource(dataset, source.id)),
    );
    const allowed = roots.data?.roots ?? [];
    return (
        <div className="flex flex-col gap-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="text-2xl font-semibold">Folders</h2>
                    <p className="text-sm text-muted-foreground">
                        Directories on this server, read in place. Every CSV, TSV, JSON, JSON Lines
                        or Parquet file of one format in a folder and its subfolders is one table.
                    </p>
                </div>
                {allowed.length > 0 && <Button onClick={() => setAdding(true)}>Add folder</Button>}
            </header>
            <ErrorLine error={roots.error} />
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Folders" value={count(members.length)} />
                <Stat label="Datasets" value={count(used.length)} />
                <Stat
                    label="Files"
                    value={count(members.reduce((sum, source) => sum + (source.files ?? 0), 0))}
                />
                <Stat
                    label="Size"
                    value={bytes(members.reduce((sum, source) => sum + source.size, 0))}
                />
            </div>
            {roots.data && allowed.length === 0 ? (
                <EmptyState
                    variant="panel"
                    title="No folders allowed yet"
                    className="mx-0 mt-0"
                    action={
                        <Button asChild variant="outline" className="mt-3">
                            <Link href="/settings/security">Open security settings</Link>
                        </Button>
                    }
                >
                    For safety, minibrain only reads folders an admin allows under Settings,
                    Security, Folder sources.
                </EmptyState>
            ) : (
                <div className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">
                        {roots.data?.locked
                            ? "Allowed folders, set by configuration:"
                            : "Allowed folders, set under Settings, Security:"}
                    </span>
                    <ul className="flex flex-col gap-0.5">
                        {allowed.map((root) => (
                            <li key={root} className="font-mono">
                                {root}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <AddFolderDialog
                open={adding}
                roots={allowed}
                onOpenChange={setAdding}
                onAdded={onAdded}
            />
        </div>
    );
}
