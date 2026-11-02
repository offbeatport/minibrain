import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
    BookOpen,
    Braces,
    Check,
    Database,
    FlaskConical,
    Info,
    type LucideIcon,
    PenLine,
    Tags,
} from "lucide-react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
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

export type AddSource = "installed" | "import";

function Choice({
    name,
    value,
    checked,
    onChange,
    children,
}: {
    name: string;
    value: string;
    checked: boolean;
    onChange: () => void;
    children: ReactNode;
}) {
    return (
        <label
            className={cn(
                "relative flex h-9 cursor-pointer items-center rounded-lg border px-3 pr-8 text-sm has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background",
                checked
                    ? "border-primary bg-accent text-accent-foreground"
                    : "bg-background hover:bg-secondary",
            )}
        >
            <input
                type="radio"
                name={name}
                value={value}
                checked={checked}
                onChange={onChange}
                className="sr-only"
            />
            {children}
            {checked && (
                <Check aria-hidden="true" className="absolute right-2.5 size-4 text-primary" />
            )}
        </label>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0">
            <h3 className="text-base font-semibold">{title}</h3>
            {children}
        </section>
    );
}

const TASKS: { key: string; label: string; hint: string; ready: boolean; icon: LucideIcon }[] = [
    { key: "classify", label: "Classify", hint: "Text → one label", ready: true, icon: Tags },
    { key: "extract", label: "Extract", hint: "Text → fields", ready: false, icon: Braces },
    {
        key: "rewrite",
        label: "Rewrite",
        hint: "Text → text in your style",
        ready: false,
        icon: PenLine,
    },
    { key: "sql", label: "Text-to-SQL", hint: "Question → SQL", ready: false, icon: Database },
    {
        key: "distill",
        label: "Distill",
        hint: "Copy a larger model",
        ready: false,
        icon: FlaskConical,
    },
    {
        key: "answer",
        label: "Answer",
        hint: "Questions over documents",
        ready: false,
        icon: BookOpen,
    },
];

function TaskSelect({ value, onChange }: { value: string; onChange: (task: string) => void }) {
    return (
        <Field id="create-task" label="Task">
            <Select value={value} onValueChange={(next) => onChange(String(next ?? "classify"))}>
                <SelectTrigger id="create-task" className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {TASKS.map((task) => {
                        const Icon = task.icon;
                        return (
                            <SelectItem
                                key={task.key}
                                value={task.key}
                                disabled={!task.ready}
                                description={task.ready ? task.hint : `${task.hint} · Later`}
                            >
                                <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                                {task.label}
                            </SelectItem>
                        );
                    })}
                </SelectContent>
            </Select>
        </Field>
    );
}

const FIT_TEXT: Record<string, string> = {
    fits: "Fits this machine",
    limited: "Limited headroom",
    insufficient: "Won't fit",
    unknown: "Fit not checked",
};

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
        <Select value={value} onValueChange={(next) => onChange(String(next ?? ""))}>
            <SelectTrigger aria-label="Base model" className="w-full">
                <SelectValue placeholder="Choose a base model" />
            </SelectTrigger>
            <SelectContent>
                {choices.map((choice) => (
                    <SelectItem
                        key={choice.key}
                        value={choice.key}
                        description={[
                            choice.size ? bytes(choice.size) : null,
                            choice.onDisk ? "On this install" : "Downloads on first training",
                            choice.entry ? FIT_TEXT[bestFit(choice.entry).fit.level] : null,
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    >
                        <PublisherLogo publisher={choice.publisher} name={choice.name} size="sm" />
                        {choice.name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
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

type Inspection = {
    ok: boolean;
    problem?: string | null;
    source_type?: string | null;
    architecture?: string | null;
    files?: number;
    size_bytes?: number;
    match?: string | null;
    name?: string | null;
    variant_id?: string | null;
};

function PathCheck({
    path,
    found,
    loading,
}: { path: string; found?: Inspection; loading: boolean }) {
    if (path.length < 2) {
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
                    ? `Matches ${found.match}; files are checked against its catalogue checksums.`
                    : "No catalogue match: it imports as not verified."}
            </span>
        </div>
    );
}

function ImportPath({
    value,
    onChange,
    found,
    loading,
}: {
    value: string;
    onChange: (value: string) => void;
    found?: Inspection;
    loading: boolean;
}) {
    return (
        <div className="flex flex-col gap-1">
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
                    <TooltipContent className="max-w-80 whitespace-normal">
                        {PATH_HELP}
                    </TooltipContent>
                </Tooltip>
            </span>
            <Input
                id="import-location"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder="/srv/models/qwen3-1.7b or s3://bucket/models/qwen3-1.7b"
                className="font-mono"
            />
            <PathCheck path={value.trim()} found={found} loading={loading} />
        </div>
    );
}

type DataSource = "upload" | "dataset" | "sample";

function TrainingData({
    source,
    onSource,
    file,
    onFile,
    dataset,
    onDataset,
}: {
    source: DataSource;
    onSource: (source: DataSource) => void;
    file: File | null;
    onFile: (file: File | null) => void;
    dataset: string;
    onDataset: (slug: string) => void;
}) {
    const datasets = useDatasets();
    const hasDatasets = (datasets.data ?? []).length > 0;
    return (
        <div className="flex flex-col gap-3 pl-6">
            <Select
                value={source}
                onValueChange={(next) => onSource((next ?? "upload") as DataSource)}
            >
                <SelectTrigger aria-label="Training data source" className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="upload" description="CSV, TSV, JSON Lines or Parquet">
                        Upload a file
                    </SelectItem>
                    <SelectItem
                        value="dataset"
                        disabled={!hasDatasets}
                        description={hasDatasets ? "One from the Data page" : "No datasets yet"}
                    >
                        Use a dataset
                    </SelectItem>
                    <SelectItem
                        value="sample"
                        description="Travel support messages labelled with intents"
                    >
                        Sample data
                    </SelectItem>
                </SelectContent>
            </Select>
            {source === "upload" && (
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
                    {file && (
                        <span className="text-sm text-muted-foreground">
                            {`${file.name} · ${bytes(file.size)}`}
                        </span>
                    )}
                </div>
            )}
            {source === "dataset" && (
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
        </div>
    );
}

function AddModelForm({
    initialSource,
    base,
    onClose,
}: {
    initialSource: AddSource;
    base?: string;
    onClose: () => void;
}) {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const bases = useBases();
    const [source, setSource] = useState<AddSource>(initialSource);
    const [chosen, setChosen] = useState(base ?? "");
    const [location, setLocation] = useState("");
    const [name, setName] = useState("");
    const [task, setTask] = useState("classify");
    const [description, setDescription] = useState("");
    const [tags, setTags] = useState("");
    const [withData, setWithData] = useState(false);
    const [dataSource, setDataSource] = useState<DataSource>("upload");
    const [file, setFile] = useState<File | null>(null);
    const [dataset, setDataset] = useState("");
    const baseKey = chosen || bases.data?.[0] || "";
    const path = useDebounced(location.trim(), 400);
    const check = useQuery({
        queryKey: ["models", "inspect", path],
        queryFn: () => unwrap(api.POST("/api/models/inspect", { body: { location: path } })),
        enabled: source === "import" && path.length > 1,
        staleTime: 10_000,
    });
    const found = path === location.trim() ? check.data : undefined;
    const add = useMutation({
        mutationFn: async () => {
            let baseModel = baseKey;
            if (source === "import") {
                const imported = await unwrap(
                    api.POST("/api/models/import", {
                        body: {
                            name: found?.name || name.trim(),
                            location: location.trim(),
                            description: "",
                            tags: [],
                            variant_id: found?.variant_id ?? null,
                        },
                    }),
                );
                baseModel = imported.key;
            }
            const created = await unwrap(
                api.POST("/api/minibrains", {
                    body: {
                        name: name.trim(),
                        description: description.trim(),
                        tags: splitTags(tags),
                        base_model: baseModel || null,
                        task: "classify",
                        sample: withData && dataSource === "sample",
                    },
                }),
            );
            if (withData && dataSource === "upload" && file) {
                await uploadSource(created.slug, file);
            }
            if (withData && dataSource === "dataset" && dataset) {
                await unwrap(
                    api.PUT("/api/minibrains/{slug}/dataset", {
                        params: { path: { slug: created.slug } },
                        body: { dataset },
                    }),
                );
            }
            return created;
        },
        onSuccess: async (created) => {
            await refresh();
            onClose();
            const slug = encodeURIComponent(created.slug);
            router.history.push(withData ? `/data?minibrain=${slug}` : `/models/custom/${slug}`);
        },
    });
    const baseReady = source === "installed" ? Boolean(baseKey) : Boolean(found?.ok);
    const dataReady =
        !withData ||
        (dataSource === "upload" && file !== null) ||
        (dataSource === "dataset" && dataset !== "") ||
        dataSource === "sample";
    const ready = baseReady && dataReady && name.trim().length > 0;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (ready) {
            add.mutate();
        }
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-4">
            <Section title="Base model">
                <div className="flex flex-wrap items-center gap-2">
                    <fieldset className="flex gap-2">
                        <legend className="sr-only">Where the base model is</legend>
                        <Choice
                            name="base-source"
                            value="installed"
                            checked={source === "installed"}
                            onChange={() => setSource("installed")}
                        >
                            On this install
                        </Choice>
                        <Choice
                            name="base-source"
                            value="import"
                            checked={source === "import"}
                            onChange={() => setSource("import")}
                        >
                            Import from a folder or S3
                        </Choice>
                    </fieldset>
                    <Link href="/discover" className="ml-auto text-sm text-primary hover:underline">
                        Download one from Discover
                    </Link>
                </div>
                {source === "installed" ? (
                    <BaseSelect value={baseKey} onChange={setChosen} />
                ) : (
                    <ImportPath
                        value={location}
                        onChange={setLocation}
                        found={found}
                        loading={check.isFetching || path !== location.trim()}
                    />
                )}
            </Section>
            <Section title="Details">
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field id="create-name" label="Name">
                        <Input
                            id="create-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="IT ticket classifier"
                            autoFocus
                        />
                    </Field>
                    <TaskSelect value={task} onChange={setTask} />
                </div>
                <Field id="create-description" label="Description (optional)">
                    <Textarea
                        id="create-description"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        rows={2}
                        placeholder="Routes incoming tickets to the right queue"
                    />
                </Field>
                <Field id="create-tags" label="Tags (optional)" hint="Comma separated.">
                    <Input
                        id="create-tags"
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                    />
                </Field>
            </Section>
            <Section title="Training data">
                <Label className="flex items-center gap-2 font-normal">
                    <Checkbox
                        checked={withData}
                        onCheckedChange={(next) => setWithData(next === true)}
                    />
                    Add training data now
                </Label>
                {withData ? (
                    <TrainingData
                        source={dataSource}
                        onSource={setDataSource}
                        file={file}
                        onFile={setFile}
                        dataset={dataset}
                        onDataset={setDataset}
                    />
                ) : (
                    <p className="pl-6 text-sm text-muted-foreground">
                        You can add examples later on the Data page. Until it is trained, the model
                        serves its base model.
                    </p>
                )}
            </Section>
            <ErrorLine error={add.error} />
            <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!ready || add.isPending}>
                    {add.isPending ? "Adding…" : "Add model"}
                </Button>
            </DialogFooter>
        </form>
    );
}

export function AddModelDialog({
    open,
    onOpenChange,
    source = "installed",
    base,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    source?: AddSource;
    base?: string;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Add model</DialogTitle>
                    <DialogDescription>
                        Start from a base model; train it on your data whenever you like.
                    </DialogDescription>
                </DialogHeader>
                {open && (
                    <AddModelForm
                        key={`${source}-${base ?? ""}`}
                        initialSource={source}
                        base={base}
                        onClose={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
