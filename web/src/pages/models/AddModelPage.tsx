import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import {
    BookOpen,
    Boxes,
    Braces,
    Check,
    ChevronLeft,
    Database,
    ExternalLink,
    FlaskConical,
    Info,
    type LucideIcon,
    PenLine,
    SquarePen,
    Tags,
} from "lucide-react";
import {
    Button,
    Checkbox,
    Field,
    FieldGroup,
    Input,
    Label,
    Link,
    SearchInput,
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
import { type CatalogEntry, type ModelRow, api, unwrap, uploadFile } from "~/api/client";
import { useBases, useCatalog, useDatasets, useModels } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { DATA_FILE_TYPES } from "~/lib/dataFiles";
import { modelsHref } from "~/lib/modelsSearch";
import { bytes } from "~/lib/time";
import { DatasetMapping } from "../DataLibrary";
import { bestFit } from "./DiscoverFilters";
import { splitTags, useModelsRefresh } from "./dialogs";

type BaseSource = "installed" | "import";
type DataSource = "upload" | "dataset" | "sample";

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

const FIT: Record<string, { text: string; tone: Tone }> = {
    fits: { text: "Fits this machine", tone: "success" },
    limited: { text: "Limited headroom", tone: "warning" },
    insufficient: { text: "Won't fit", tone: "destructive" },
    unknown: { text: "Fit not checked", tone: "neutral" },
};

function Choice({
    name,
    value,
    checked,
    onChange,
    children,
    className,
}: {
    name: string;
    value: string;
    checked: boolean;
    onChange: () => void;
    children: ReactNode;
    className?: string;
}) {
    return (
        <label
            className={cn(
                "relative flex cursor-pointer rounded-lg border has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background",
                checked
                    ? "border-primary bg-accent text-accent-foreground"
                    : "bg-card hover:bg-secondary",
                className,
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
                <Check
                    aria-hidden="true"
                    className="absolute top-2.5 right-2.5 size-4 text-primary"
                />
            )}
        </label>
    );
}

type BaseChoice = {
    key: string;
    name: string;
    publisher: string | null | undefined;
    size: number | null | undefined;
    onDisk: boolean;
    gguf: boolean;
    entry: CatalogEntry | undefined;
};

function baseChoices(keys: string[], rows: ModelRow[], entries: CatalogEntry[]): BaseChoice[] {
    return keys.map((key) => {
        const row = rows.find((item) => item.kind === "base" && item.key === key);
        const entry =
            entries.find((item) => item.added.some((added) => added.key === key)) ??
            entries.find((item) => item.id === key);
        const variantId = entry?.added.find((added) => added.key === key)?.variant_id;
        const variant = entry?.variants.find((item) => item.id === variantId);
        return {
            key,
            name: row?.name ?? entry?.name ?? key,
            publisher: row?.publisher ?? entry?.provider,
            size: row?.size_bytes ?? entry?.variants[0]?.size_bytes,
            onDisk: row?.availability.state === "available",
            gguf: variant?.format === "gguf",
            entry,
        };
    });
}

function BaseCard({
    choice,
    checked,
    onChange,
}: { choice: BaseChoice; checked: boolean; onChange: () => void }) {
    const fit = choice.entry ? FIT[bestFit(choice.entry).fit.level] : undefined;
    const facts = [
        choice.entry ? `${choice.entry.params_b.toFixed(1)}B parameters` : null,
        choice.size ? bytes(choice.size) : null,
    ].filter(Boolean);
    return (
        <Choice
            name="base"
            value={choice.key}
            checked={checked}
            onChange={onChange}
            className="gap-3 p-3 pr-9"
        >
            <PublisherLogo publisher={choice.publisher} name={choice.name} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-semibold">{choice.name}</span>
                <span className="text-sm text-muted-foreground tabular-nums">
                    {facts.join(" · ")}
                </span>
                <span className="flex flex-wrap items-center gap-x-3 text-sm">
                    <span className="text-muted-foreground">
                        {choice.onDisk ? "On this install" : "Downloads on first training"}
                    </span>
                    {fit && <StatusText tone={fit.tone}>{fit.text}</StatusText>}
                </span>
                {choice.gguf && (
                    <span className="text-sm text-muted-foreground">
                        GGUF: serves, but cannot be fine-tuned
                    </span>
                )}
                {choice.entry?.license_name && (
                    <span className="truncate text-sm text-muted-foreground">
                        {choice.entry.license_name}
                    </span>
                )}
            </span>
        </Choice>
    );
}

function BaseChooser({ value, onChange }: { value: string; onChange: (key: string) => void }) {
    const bases = useBases();
    const models = useModels();
    const catalog = useCatalog();
    const [query, setQuery] = useState("");
    const choices = baseChoices(bases.data ?? [], models.data ?? [], catalog.data?.entries ?? []);
    const text = query.trim().toLowerCase();
    const shown = text
        ? choices.filter((choice) =>
              `${choice.name} ${choice.key} ${choice.publisher ?? ""}`.toLowerCase().includes(text),
          )
        : choices;
    if (bases.isLoading) {
        return <p className="text-sm text-muted-foreground">Loading base models…</p>;
    }
    return (
        <div className="flex flex-col gap-3">
            {choices.length > 6 && (
                <SearchInput
                    aria-label="Search base models"
                    placeholder="Search base models"
                    value={query}
                    onValueChange={setQuery}
                    className="w-full max-w-xs"
                />
            )}
            <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="sr-only">Base model</legend>
                {shown.map((choice) => (
                    <BaseCard
                        key={choice.key}
                        choice={choice}
                        checked={value === choice.key}
                        onChange={() => onChange(choice.key)}
                    />
                ))}
            </fieldset>
            {shown.length === 0 && (
                <p className="text-sm text-muted-foreground">No base model matches.</p>
            )}
        </div>
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
        <div className="flex flex-col gap-0.5 rounded-md border bg-card px-3 py-2 text-sm">
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
        <div className="flex flex-col gap-1.5">
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

function stem(filename: string): string {
    return (
        filename
            .replace(/\.[^.]+$/, "")
            .replace(/[_-]+/g, " ")
            .trim() || "Uploaded data"
    );
}

function TrainingData({
    source,
    onSource,
    dataset,
    onDataset,
}: {
    source: DataSource;
    onSource: (source: DataSource) => void;
    dataset: string;
    onDataset: (slug: string) => void;
}) {
    const datasets = useDatasets();
    const hasDatasets = (datasets.data ?? []).length > 0;
    const [file, setFile] = useState<File | null>(null);
    const upload = useMutation({
        mutationFn: async (chosen: File) => {
            const uploaded = await uploadFile(chosen);
            return unwrap(
                api.POST("/api/datasets", {
                    body: { name: stem(chosen.name), source_id: uploaded.id },
                }),
            );
        },
        onSuccess: (created) => onDataset(created.slug),
    });
    return (
        <div className="flex flex-col gap-4 pl-6">
            <Select
                value={source}
                onValueChange={(next) => {
                    onSource((next ?? "upload") as DataSource);
                    onDataset("");
                }}
            >
                <SelectTrigger aria-label="Training data source" className="w-full max-w-sm">
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
                <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button asChild variant="outline">
                            <label className="cursor-pointer">
                                {file ? "Choose another file" : "Choose file"}
                                <input
                                    type="file"
                                    accept={DATA_FILE_TYPES}
                                    className="sr-only"
                                    onChange={(event) => {
                                        const chosen = event.target.files?.[0];
                                        event.target.value = "";
                                        if (chosen) {
                                            setFile(chosen);
                                            upload.mutate(chosen);
                                        }
                                    }}
                                />
                            </label>
                        </Button>
                        {file && (
                            <span className="text-sm text-muted-foreground">
                                {upload.isPending
                                    ? `Reading ${file.name}…`
                                    : `${file.name} · ${bytes(file.size)}`}
                            </span>
                        )}
                    </div>
                    <span className="text-sm text-muted-foreground">
                        The file is added to Data, where other models can use it too.
                    </span>
                    <ErrorLine error={upload.error} />
                </div>
            )}
            {source === "dataset" && (
                <Select value={dataset} onValueChange={(value) => onDataset(String(value ?? ""))}>
                    <SelectTrigger aria-label="Dataset" className="w-full max-w-sm">
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
            {source !== "sample" && dataset && (
                <div className="flex flex-col gap-4">
                    <DatasetMapping slug={dataset} />
                </div>
            )}
        </div>
    );
}

export function AddModelPage() {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const params = useRouterState({
        select: (state) => state.location.search as { base?: string; source?: string },
    });
    const bases = useBases();
    const [source, setSource] = useState<BaseSource>(
        params.source === "import" ? "import" : "installed",
    );
    const [chosen, setChosen] = useState(params.base ?? "");
    const [location, setLocation] = useState("");
    const [name, setName] = useState("");
    const [task, setTask] = useState("classify");
    const [description, setDescription] = useState("");
    const [tags, setTags] = useState("");
    const [withData, setWithData] = useState(false);
    const [dataSource, setDataSource] = useState<DataSource>("upload");
    const [dataset, setDataset] = useState("");
    const catalog = useCatalog();
    const recommended = (bases.data ?? []).find((key) =>
        catalog.data?.entries.some((entry) => entry.recommended && entry.id === key),
    );
    const baseKey = chosen || recommended || bases.data?.[0] || "";
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
            if (withData && dataSource !== "sample" && dataset) {
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
            router.history.push(`/models/custom/${encodeURIComponent(created.slug)}`);
        },
    });
    const baseReady = source === "installed" ? Boolean(baseKey) : Boolean(found?.ok);
    const dataReady = !withData || dataSource === "sample" || dataset !== "";
    const ready = baseReady && dataReady && name.trim().length > 0;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (ready) {
            add.mutate();
        }
    };
    return (
        <Page>
            <Link
                href={modelsHref()}
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ChevronLeft className="size-4" />
                Models
            </Link>
            <PageHeader
                title="Add model"
                caption="Start from a base model; train it on your data whenever you like."
            />
            <form onSubmit={submit} className="flex max-w-4xl flex-col gap-8">
                <PanelSections>
                    <PanelSection
                        icon={Boxes}
                        title="Base model"
                        actions={
                            <a
                                href="/discover"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                            >
                                Discover more models
                                <ExternalLink className="size-3.5" />
                            </a>
                        }
                        bare
                    >
                        <div className="flex flex-col gap-4">
                            <fieldset className="flex flex-wrap gap-2">
                                <legend className="sr-only">Where the base model is</legend>
                                <Choice
                                    name="base-source"
                                    value="installed"
                                    checked={source === "installed"}
                                    onChange={() => setSource("installed")}
                                    className="h-9 items-center px-3 pr-9 text-sm"
                                >
                                    On this install
                                </Choice>
                                <Choice
                                    name="base-source"
                                    value="import"
                                    checked={source === "import"}
                                    onChange={() => setSource("import")}
                                    className="h-9 items-center px-3 pr-9 text-sm"
                                >
                                    Import from a folder or S3
                                </Choice>
                            </fieldset>
                            {source === "installed" ? (
                                <BaseChooser value={baseKey} onChange={setChosen} />
                            ) : (
                                <ImportPath
                                    value={location}
                                    onChange={setLocation}
                                    found={found}
                                    loading={check.isFetching || path !== location.trim()}
                                />
                            )}
                        </div>
                    </PanelSection>
                    <PanelSection icon={SquarePen} title="Details">
                        <FieldGroup>
                            <div className="grid gap-5 sm:grid-cols-2">
                                <Field id="create-name" label="Name">
                                    <Input
                                        id="create-name"
                                        value={name}
                                        onChange={(event) => setName(event.target.value)}
                                        placeholder="IT ticket classifier"
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
                        </FieldGroup>
                    </PanelSection>
                    <PanelSection icon={Database} title="Training data">
                        <div className="flex flex-col gap-3">
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
                                    dataset={dataset}
                                    onDataset={setDataset}
                                />
                            ) : (
                                <p className="pl-6 text-sm text-muted-foreground">
                                    You can add examples later on the Data page. Until it is
                                    trained, the model serves its base model.
                                </p>
                            )}
                        </div>
                    </PanelSection>
                </PanelSections>
                <ErrorLine error={add.error} />
                <div className="flex justify-end gap-2 border-t pt-4">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => router.history.push(modelsHref())}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" disabled={!ready || add.isPending}>
                        {add.isPending ? "Adding…" : "Add model"}
                    </Button>
                </div>
            </form>
        </Page>
    );
}
