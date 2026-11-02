import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronRight, Info, PackagePlus, Sparkles } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { type CatalogEntry, type ModelRow, api, unwrap, uploadSource } from "~/api/client";
import { useBases, useCatalog, useDatasets, useModels } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { DATA_FILE_TYPES } from "~/lib/dataFiles";
import { bytes } from "~/lib/time";
import { bestFit } from "./DiscoverFilters";
import { Field, splitTags, useModelsRefresh } from "./dialogs";

export type AddSource = "custom" | "import";

function RadioCard({
    name,
    value,
    checked,
    disabled,
    onChange,
    children,
    className,
}: {
    name: string;
    value: string;
    checked: boolean;
    disabled?: boolean;
    onChange: () => void;
    children: ReactNode;
    className?: string;
}) {
    return (
        <label
            className={cn(
                "relative flex rounded-lg border has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background",
                disabled
                    ? "cursor-not-allowed bg-background opacity-60"
                    : checked
                      ? "cursor-pointer border-primary bg-accent text-accent-foreground"
                      : "cursor-pointer bg-background hover:bg-secondary",
                className,
            )}
        >
            <input
                type="radio"
                name={name}
                value={value}
                checked={checked}
                disabled={disabled}
                onChange={onChange}
                className="sr-only"
            />
            {children}
            {checked && (
                <Check
                    aria-hidden="true"
                    className="absolute top-2.5 right-2.5 size-4 text-primary"
                />
            )}
        </label>
    );
}

const SOURCES: { key: AddSource; label: string; hint: string; icon: typeof Sparkles }[] = [
    {
        key: "custom",
        label: "Custom model",
        hint: "Train a base model you have on your data",
        icon: Sparkles,
    },
    {
        key: "import",
        label: "Import files",
        hint: "Bring in a base model from a folder or S3",
        icon: PackagePlus,
    },
];

const TASKS: { key: string; label: string; hint: string; ready: boolean }[] = [
    { key: "classify", label: "Classify", hint: "Text → one label", ready: true },
    { key: "extract", label: "Extract", hint: "Text → fields", ready: false },
    { key: "rewrite", label: "Rewrite", hint: "Text → text in your style", ready: false },
    { key: "sql", label: "Text-to-SQL", hint: "Question → SQL", ready: false },
    { key: "distill", label: "Distill", hint: "Copy a larger model", ready: false },
    { key: "answer", label: "Answer", hint: "Questions over documents", ready: false },
];

const FIT_TEXT: Record<string, string> = {
    fits: "Fits this machine",
    limited: "Limited headroom",
    insufficient: "Won't fit",
    unknown: "Fit not checked",
};

function TaskSelect({ value, onChange }: { value: string; onChange: (task: string) => void }) {
    return (
        <Field id="create-task" label="Task">
            <Select value={value} onValueChange={(next) => onChange(String(next ?? "classify"))}>
                <SelectTrigger id="create-task" className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {TASKS.map((task) => (
                        <SelectItem
                            key={task.key}
                            value={task.key}
                            disabled={!task.ready}
                            description={task.ready ? task.hint : `${task.hint} · Later`}
                        >
                            {task.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
}

type BaseChoice = {
    key: string;
    name: string;
    publisher: string | null | undefined;
    size: number | null | undefined;
    onDisk: boolean;
    entry: CatalogEntry | undefined;
};

function baseChoices(keys: string[], rows: ModelRow[], entries: CatalogEntry[]): BaseChoice[] {
    return keys.map((key) => {
        const row = rows.find((item) => item.kind === "base" && item.key === key);
        const entry =
            entries.find((item) => item.added.some((added) => added.key === key)) ??
            entries.find((item) => item.id === key);
        return {
            key,
            name: row?.name ?? entry?.name ?? key,
            publisher: row?.publisher ?? entry?.provider,
            size: row?.size_bytes ?? entry?.variants[0]?.size_bytes,
            onDisk: row?.availability.state === "available",
            entry,
        };
    });
}

function BaseSelect({ value, onChange }: { value: string; onChange: (key: string) => void }) {
    const bases = useBases();
    const models = useModels();
    const catalog = useCatalog();
    const choices = baseChoices(bases.data ?? [], models.data ?? [], catalog.data?.entries ?? []);
    return (
        <Field id="create-base" label="Base model">
            <Select value={value} onValueChange={(next) => onChange(String(next ?? ""))}>
                <SelectTrigger id="create-base" className="w-full">
                    <SelectValue placeholder="Choose a base model" />
                </SelectTrigger>
                <SelectContent>
                    {choices.map((choice) => (
                        <SelectItem
                            key={choice.key}
                            value={choice.key}
                            icon={
                                <PublisherLogo
                                    publisher={choice.publisher}
                                    name={choice.name}
                                    size="sm"
                                />
                            }
                            description={[
                                choice.size ? bytes(choice.size) : null,
                                choice.onDisk ? "On this install" : "Downloads on first training",
                                choice.entry ? FIT_TEXT[bestFit(choice.entry).fit.level] : null,
                            ]
                                .filter(Boolean)
                                .join(" · ")}
                        >
                            {choice.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
                Need another base?{" "}
                <Link href="/discover?train=yes" className="text-primary hover:underline">
                    Find models that can be fine-tuned
                </Link>
            </span>
        </Field>
    );
}

type DataChoice = "upload" | "dataset" | "sample" | "later";

const DATA_CHOICES: { key: DataChoice; label: string }[] = [
    { key: "upload", label: "Upload a file" },
    { key: "dataset", label: "Use a dataset" },
    { key: "sample", label: "Sample data" },
    { key: "later", label: "Later" },
];

function DataPicker({
    choice,
    onChoice,
    file,
    onFile,
    dataset,
    onDataset,
}: {
    choice: DataChoice;
    onChoice: (choice: DataChoice) => void;
    file: File | null;
    onFile: (file: File | null) => void;
    dataset: string;
    onDataset: (slug: string) => void;
}) {
    const datasets = useDatasets();
    return (
        <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">Examples</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {DATA_CHOICES.map((item) => (
                    <RadioCard
                        key={item.key}
                        name="data"
                        value={item.key}
                        checked={choice === item.key}
                        disabled={item.key === "dataset" && (datasets.data ?? []).length === 0}
                        onChange={() => onChoice(item.key)}
                        className="h-9 items-center px-3 pr-8 text-sm"
                    >
                        {item.label}
                    </RadioCard>
                ))}
            </div>
            {choice === "upload" && (
                <div className="flex flex-wrap items-center gap-2">
                    <Button asChild variant="outline">
                        <label className="cursor-pointer">
                            {file ? "Choose another file" : "Choose file"}
                            <input
                                type="file"
                                accept={DATA_FILE_TYPES}
                                className="sr-only"
                                onChange={(event) => onFile(event.target.files?.[0] ?? null)}
                            />
                        </label>
                    </Button>
                    <span className="text-sm text-muted-foreground">
                        {file
                            ? `${file.name} · ${bytes(file.size)}`
                            : "CSV, TSV, JSON Lines or Parquet"}
                    </span>
                </div>
            )}
            {choice === "dataset" && (
                <Select value={dataset} onValueChange={(value) => onDataset(String(value ?? ""))}>
                    <SelectTrigger aria-label="Dataset" className="w-full">
                        <SelectValue placeholder="Choose a dataset" />
                    </SelectTrigger>
                    <SelectContent>
                        {(datasets.data ?? []).map((item) => (
                            <SelectItem key={item.slug} value={item.slug}>
                                {item.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            {choice === "sample" && (
                <p className="text-sm text-muted-foreground">
                    Travel support messages labelled with intents such as lost luggage or refunds.
                </p>
            )}
            {choice === "later" && (
                <p className="text-sm text-muted-foreground">Add examples on the Data page next.</p>
            )}
        </fieldset>
    );
}

function MoreOptions({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const Icon = open ? ChevronDown : ChevronRight;
    return (
        <div className="flex flex-col gap-3">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
                <Icon className="size-4" />
                More options
            </button>
            {open && children}
        </div>
    );
}

function DialogButtons({
    onCancel,
    submit,
    disabled,
}: {
    onCancel: () => void;
    submit: string;
    disabled: boolean;
}) {
    return (
        <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
            </Button>
            <Button type="submit" disabled={disabled}>
                {submit}
            </Button>
        </DialogFooter>
    );
}

function CustomForm({ base, onClose }: { base?: string; onClose: () => void }) {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const bases = useBases();
    const [task, setTask] = useState("classify");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [tags, setTags] = useState("");
    const [chosen, setChosen] = useState(base ?? "");
    const [data, setData] = useState<DataChoice>("upload");
    const [file, setFile] = useState<File | null>(null);
    const [dataset, setDataset] = useState("");
    const baseKey = chosen || bases.data?.[0] || "";
    const create = useMutation({
        mutationFn: async () => {
            const created = await unwrap(
                api.POST("/api/minibrains", {
                    body: {
                        name: name.trim(),
                        description: description.trim(),
                        tags: splitTags(tags),
                        base_model: baseKey || null,
                        task: "classify",
                        sample: data === "sample",
                    },
                }),
            );
            if (data === "upload" && file) {
                await uploadSource(created.slug, file);
            }
            if (data === "dataset" && dataset) {
                await unwrap(
                    api.PUT("/api/minibrains/{slug}/dataset", {
                        params: { path: { slug: created.slug } },
                        body: { dataset },
                    }),
                );
            }
            return created;
        },
        onSuccess: async (minibrain) => {
            await refresh();
            onClose();
            router.history.push(`/data?minibrain=${encodeURIComponent(minibrain.slug)}`);
        },
    });
    const missingData = (data === "upload" && !file) || (data === "dataset" && !dataset);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (name.trim() && !missingData) {
            create.mutate();
        }
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-5">
            <Field id="create-name" label="Name">
                <Input
                    id="create-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="IT ticket classifier"
                    autoFocus
                />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
                <TaskSelect value={task} onChange={setTask} />
                <BaseSelect value={baseKey} onChange={setChosen} />
            </div>
            <DataPicker
                choice={data}
                onChoice={setData}
                file={file}
                onFile={setFile}
                dataset={dataset}
                onDataset={setDataset}
            />
            <MoreOptions>
                <Field id="create-description" label="Description">
                    <Textarea
                        id="create-description"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        rows={2}
                        placeholder="Routes incoming tickets to the right queue"
                    />
                </Field>
                <Field id="create-tags" label="Tags" hint="Comma separated.">
                    <Input
                        id="create-tags"
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                    />
                </Field>
            </MoreOptions>
            <ErrorLine error={create.error} />
            <DialogButtons
                onCancel={onClose}
                submit={create.isPending ? "Adding…" : "Add model"}
                disabled={!name.trim() || missingData || create.isPending}
            />
        </form>
    );
}

function useDebounced(value: string, ms: number): string {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setSettled(value), ms);
        return () => window.clearTimeout(timer);
    }, [value, ms]);
    return settled;
}

const PATH_HELP =
    "A Hugging Face format model: config.json, tokenizer files and .safetensors weights (sharded is fine). Use an absolute folder path on the minibrain server, or an s3:// URL read with the server's AWS_* credentials.";

function PathLabel() {
    return (
        <span className="flex items-center gap-1.5">
            <label htmlFor="import-location" className="text-sm font-medium">
                Folder or S3 path
            </label>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        type="button"
                        aria-label="What can I import?"
                        className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                        <Info className="size-4" />
                    </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-80 whitespace-normal">{PATH_HELP}</TooltipContent>
            </Tooltip>
        </span>
    );
}

type Inspection = {
    ok: boolean;
    problem?: string | null;
    warning?: string | null;
    source_type?: string | null;
    architecture?: string | null;
    files?: number;
    size_bytes?: number;
    match?: string | null;
};

function PathCheck({
    loading,
    empty,
    found,
}: {
    loading: boolean;
    empty: boolean;
    found: Inspection | undefined;
}) {
    if (empty) {
        return null;
    }
    if (loading || !found) {
        return <span className="text-sm text-muted-foreground">Checking…</span>;
    }
    if (!found.ok) {
        return (
            <StatusText tone="destructive">{found.problem ?? "Cannot read this path"}</StatusText>
        );
    }
    const where = found.source_type === "s3" ? "S3" : "Folder";
    return (
        <div className="flex flex-col gap-0.5 rounded-md border px-3 py-2 text-sm">
            <StatusText tone="success">
                {`${where} · ${found.architecture || "unknown architecture"} · ${found.files} files · ${bytes(found.size_bytes)}`}
            </StatusText>
            <span className="text-muted-foreground">
                {found.match
                    ? `Matches ${found.match} in the catalogue; files are checked against its checksums.`
                    : "No catalogue match: it imports as not verified."}
            </span>
            {found.warning && <StatusText tone="warning">{found.warning}</StatusText>}
        </div>
    );
}

function ImportForm({ onClose }: { onClose: () => void }) {
    const refresh = useModelsRefresh();
    const [location, setLocation] = useState("");
    const [name, setName] = useState("");
    const [named, setNamed] = useState(false);
    const [description, setDescription] = useState("");
    const path = useDebounced(location.trim(), 400);
    const check = useQuery({
        queryKey: ["models", "inspect", path],
        queryFn: () => unwrap(api.POST("/api/models/inspect", { body: { location: path } })),
        enabled: path.length > 1,
        staleTime: 10_000,
    });
    const found = path === location.trim() ? check.data : undefined;
    const shownName = named ? name : (found?.name ?? name);
    const start = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/models/import", {
                    body: {
                        name: shownName.trim(),
                        location: location.trim(),
                        description: description.trim(),
                        tags: [],
                        variant_id: found?.variant_id ?? null,
                    },
                }),
            ),
        onSuccess: async () => {
            await refresh();
            onClose();
        },
    });
    const ready = Boolean(found?.ok) && shownName.trim().length > 0;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (ready) {
            start.mutate();
        }
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
                <PathLabel />
                <Input
                    id="import-location"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="/srv/models/qwen3-1.7b or s3://bucket/models/qwen3-1.7b"
                    className="font-mono"
                    autoFocus
                />
                <PathCheck
                    loading={check.isFetching || path !== location.trim()}
                    empty={location.trim().length < 2}
                    found={found}
                />
            </div>
            <Field id="import-name" label="Name">
                <Input
                    id="import-name"
                    value={shownName}
                    onChange={(event) => {
                        setName(event.target.value);
                        setNamed(true);
                    }}
                />
            </Field>
            <MoreOptions>
                <Field id="import-description" label="Description">
                    <Input
                        id="import-description"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </Field>
            </MoreOptions>
            <p className="text-sm text-muted-foreground">
                Files are copied into managed storage and stay on your infrastructure.
            </p>
            <ErrorLine error={start.error} />
            <DialogButtons
                onCancel={onClose}
                submit={start.isPending ? "Importing…" : "Import"}
                disabled={!ready || start.isPending}
            />
        </form>
    );
}

export function AddModelDialog({
    open,
    onOpenChange,
    source = "custom",
    base,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    source?: AddSource;
    base?: string;
}) {
    const router = useRouter();
    const [chosen, setChosen] = useState<{ for: AddSource; value: AddSource } | null>(null);
    const current = chosen && chosen.for === source ? chosen.value : source;
    const close = () => {
        setChosen(null);
        onOpenChange(false);
    };
    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Add model</DialogTitle>
                    <DialogDescription>Choose what to add.</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-5">
                    <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <legend className="sr-only">What to add</legend>
                        {SOURCES.map((option) => {
                            const selected = option.key === current;
                            const Icon = option.icon;
                            return (
                                <RadioCard
                                    key={option.key}
                                    name="add-source"
                                    value={option.key}
                                    checked={selected}
                                    onChange={() => setChosen({ for: source, value: option.key })}
                                    className="items-start gap-3 p-3 pr-9"
                                >
                                    <Icon
                                        aria-hidden="true"
                                        className={cn(
                                            "size-6 shrink-0",
                                            selected ? "text-primary" : "text-muted-foreground",
                                        )}
                                    />
                                    <span className="flex flex-col">
                                        <span className="font-semibold">{option.label}</span>
                                        <span className="text-sm text-muted-foreground">
                                            {option.hint}
                                        </span>
                                    </span>
                                </RadioCard>
                            );
                        })}
                    </fieldset>
                    {current === "custom" ? (
                        <CustomForm key={`custom-${base}`} base={base} onClose={close} />
                    ) : (
                        <ImportForm key="import" onClose={close} />
                    )}
                    <p className="border-t pt-3 text-sm text-muted-foreground">
                        Looking for a model to download?{" "}
                        <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => {
                                close();
                                router.history.push("/discover");
                            }}
                        >
                            Browse Discover
                        </button>
                    </p>
                </div>
            </DialogContent>
        </Dialog>
    );
}
