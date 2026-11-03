import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import {
    BookOpen,
    Boxes,
    Braces,
    ChevronLeft,
    Database,
    ExternalLink,
    FlaskConical,
    type LucideIcon,
    PenLine,
    SquarePen,
    Tags,
} from "lucide-react";
import {
    Button,
    Card,
    Field,
    FieldGroup,
    Input,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    cn,
} from "obp-ui";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { type CatalogEntry, type ModelRow, api, unwrap } from "~/api/client";
import { keys, useCatalog, useModels } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { modelsHref } from "~/lib/modelsSearch";
import { bytes } from "~/lib/time";
import { BasePicker, type PickerTab } from "./BasePicker";
import { type ImportPick, type SourcePlan, formatLabel, useSourcePlan } from "./BaseSource";
import { BaseSummary, type CopySource, type DiskNeed, diskBlocks, diskNeed } from "./BaseSummary";
import { useCacheCheck } from "./ModelCache";
import {
    type BaseOption,
    type TaskKey,
    baseOptionFor,
    catalogueOption,
    recommend,
} from "./baseOptions";
import { splitTags, useModelsRefresh } from "./dialogs";

const TASKS: {
    key: TaskKey;
    label: string;
    noun: string;
    hint: string;
    ready: boolean;
    icon: LucideIcon;
}[] = [
    {
        key: "classify",
        label: "Classify",
        noun: "classification",
        hint: "Text → one label",
        ready: true,
        icon: Tags,
    },
    {
        key: "extract",
        label: "Extract",
        noun: "extraction",
        hint: "Text → fields",
        ready: false,
        icon: Braces,
    },
    {
        key: "rewrite",
        label: "Rewrite",
        noun: "rewriting",
        hint: "Text → text in your style",
        ready: false,
        icon: PenLine,
    },
    {
        key: "sql",
        label: "Text-to-SQL",
        noun: "text-to-SQL",
        hint: "Question → SQL",
        ready: false,
        icon: Database,
    },
    {
        key: "distill",
        label: "Distill",
        noun: "distillation",
        hint: "Copy a larger model",
        ready: false,
        icon: FlaskConical,
    },
    {
        key: "answer",
        label: "Answer",
        noun: "answering questions",
        hint: "Questions over documents",
        ready: false,
        icon: BookOpen,
    },
];

type Picked =
    | { kind: "base"; key: string }
    | { kind: "catalogue"; id: string; variant: string }
    | { kind: "import"; text: string };

type Search = {
    base?: string;
    source?: string;
    model?: string;
    variant?: string;
    dataset?: string;
};

function initialPick(params: Search): Picked | null {
    if (params.model) {
        return {
            kind: "catalogue",
            id: String(params.model),
            variant: params.variant ? String(params.variant) : "",
        };
    }
    return params.base ? { kind: "base", key: String(params.base) } : null;
}

function taskOf(value: string): TaskKey {
    return TASKS.find((task) => task.key === value)?.key ?? "classify";
}

function TaskSelect({ value, onChange }: { value: TaskKey; onChange: (task: TaskKey) => void }) {
    return (
        <Field id="create-task" label="Task">
            <Select value={value} onValueChange={(next) => onChange(taskOf(String(next ?? "")))}>
                <SelectTrigger id="create-task" className="w-full sm:max-w-sm">
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

function chosenOption(
    current: Picked | null,
    entries: CatalogEntry[],
    rows: ModelRow[],
): BaseOption | null {
    if (current?.kind === "base") {
        return baseOptionFor(current.key, entries, rows);
    }
    if (current?.kind === "catalogue") {
        const entry = entries.find((item) => item.id === current.id);
        return entry ? catalogueOption(entry, current.variant || undefined) : null;
    }
    return null;
}

function slugOf(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug.slice(0, 48).replace(/-+$/, "") || "minibrain";
}

const LOW_SPACE = 5 * 1024 ** 3;

function DiskPanel({
    option,
    plan,
    need,
    free,
}: {
    option: BaseOption | null;
    plan: SourcePlan;
    need: DiskNeed;
    free: number | null | undefined;
}) {
    const variant = plan.variant ?? option?.variant ?? null;
    const known = free !== null && free !== undefined;
    const after = need && known ? free - need.size : null;
    const download = need
        ? `${bytes(need.size)}${need.verb === "import" ? " to import" : ""}`
        : option
          ? "None, already on this install"
          : "Pick a base model";
    const disk = !known
        ? "Unknown"
        : after === null
          ? `${bytes(free)} free`
          : after < 0
            ? `${bytes(free)} free, not enough`
            : `${bytes(free)} free, ${bytes(after)} after`;
    return (
        <Card className="gap-3 px-5 text-sm">
            <dl className="flex flex-col gap-3">
                <div className="flex flex-col gap-0.5">
                    <dt className="text-muted-foreground">Format</dt>
                    <dd>
                        {variant ? formatLabel(variant) : option ? "As installed" : "Not chosen"}
                    </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                    <dt className="text-muted-foreground">Download</dt>
                    <dd className="tabular-nums">{download}</dd>
                </div>
                <div className="flex flex-col gap-0.5">
                    <dt className="text-muted-foreground">Disk</dt>
                    <dd
                        className={cn(
                            "tabular-nums",
                            after !== null && after < 0 && "text-destructive",
                            after !== null && after >= 0 && after < LOW_SPACE && "text-warning",
                        )}
                    >
                        {disk}
                    </dd>
                </div>
            </dl>
        </Card>
    );
}

function trainingHref(slug: string, copy: CopySource | null): string {
    const path = `/training/${encodeURIComponent(slug)}`;
    if (!copy?.recipe) {
        return path;
    }
    const query = new URLSearchParams({
        rows: String(copy.recipe.rows),
        epochs: String(copy.recipe.epochs),
    });
    return `${path}?${query.toString()}`;
}

export function AddModelPage() {
    const router = useRouter();
    const client = useQueryClient();
    const refresh = useModelsRefresh();
    const cacheCheck = useCacheCheck();
    const params = useRouterState({ select: (state) => state.location.search as Search });
    const models = useModels();
    const catalog = useCatalog();
    const [task, setTask] = useState<TaskKey>("classify");
    const [picked, setPicked] = useState<Picked | null>(() => initialPick(params));
    const [accepted, setAccepted] = useState(false);
    const [open, setOpen] = useState(params.source === "import");
    const [tab, setTab] = useState<PickerTab>(
        params.source === "import" ? "import" : "recommended",
    );
    const [copy, setCopy] = useState<CopySource | null>(null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [tags, setTags] = useState("");
    const [dataset, setDataset] = useState(
        params.dataset === undefined ? "" : String(params.dataset),
    );
    const entries = catalog.data?.entries ?? [];
    const rows = models.data ?? [];
    const picks = recommend(entries, rows, task);
    const top = picks.here[0] ?? picks.unchecked[0] ?? picks.more[0];
    const fallback: Picked | null = top?.entry
        ? { kind: "catalogue", id: top.entry.id, variant: top.variant?.id ?? "" }
        : null;
    const current = picked ?? fallback;
    const option = chosenOption(current, entries, rows);
    const plan = useSourcePlan({
        text: option?.entry ? option.entry.id : current?.kind === "import" ? current.text : "",
        variant: option?.variant?.id ?? "",
        accepted,
    });
    const need = diskNeed(option, plan, catalog.data?.store_free_bytes);
    const startFrom = useMutation({
        mutationFn: async (row: ModelRow) => {
            const path = { params: { path: { slug: row.key } } };
            const [detail, versions] = await Promise.all([
                client.fetchQuery({
                    queryKey: keys.minibrain(row.key),
                    queryFn: () => unwrap(api.GET("/api/minibrains/{slug}", path)),
                }),
                client.fetchQuery({
                    queryKey: keys.versions(row.key),
                    queryFn: () => unwrap(api.GET("/api/minibrains/{slug}/versions", path)),
                }),
            ]);
            return { detail, versions };
        },
        onSuccess: ({ detail, versions }) => {
            const trainedVersions = versions
                .filter((version) => version.kind === "lora" && version.status === "ready")
                .sort((a, b) => b.number - a.number);
            const trained =
                trainedVersions.find((version) => version.current) ?? trainedVersions[0];
            setTask(taskOf(detail.task));
            choose({ kind: "base", key: detail.base_model });
            setDataset(detail.dataset ?? "");
            setCopy({
                slug: detail.slug,
                name: detail.name,
                datasetName: detail.dataset ? (detail.dataset_name ?? detail.dataset) : null,
                recipe: trained
                    ? {
                          rows: Number(trained.recipe.max_rows ?? 3000),
                          epochs: Number(trained.recipe.epochs ?? 1),
                          version: trained.number,
                      }
                    : null,
            });
        },
    });
    const choose = (next: Picked) => {
        setPicked(next);
        setAccepted(false);
        setOpen(false);
    };
    const pick = (chosen: BaseOption) => {
        if (chosen.kind === "custom" && chosen.custom) {
            startFrom.mutate(chosen.custom);
            return;
        }
        if (copy) {
            setCopy(null);
            setDataset(params.dataset === undefined ? "" : String(params.dataset));
        }
        choose(
            chosen.entry
                ? { kind: "catalogue", id: chosen.entry.id, variant: chosen.variant?.id ?? "" }
                : { kind: "base", key: chosen.baseKey ?? "" },
        );
    };
    const importPick = (found: ImportPick) => {
        setCopy(null);
        if (found.kind === "catalogue") {
            const fresh = catalogueOption(found.entry);
            choose({ kind: "catalogue", id: found.entry.id, variant: fresh.variant?.id ?? "" });
            return;
        }
        choose({ kind: "import", text: found.text });
    };
    const suggestedName = copy
        ? `${copy.name} copy`
        : (option?.name ?? (current?.kind === "import" ? plan.name : undefined) ?? "");
    const add = useMutation({
        mutationFn: async () => {
            const baseModel =
                option?.kind === "local" && option.baseKey ? option.baseKey : await plan.run();
            const created = await unwrap(
                api.POST("/api/minibrains", {
                    body: {
                        name: name.trim() || suggestedName,
                        description: description.trim(),
                        tags: splitTags(tags),
                        base_model: baseModel || null,
                        task,
                    },
                }),
            );
            if (dataset) {
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
            router.history.push(
                copy || dataset
                    ? trainingHref(created.slug, copy)
                    : `/models/custom/${encodeURIComponent(created.slug)}`,
            );
        },
    });
    const baseReady =
        (option?.kind === "local" ? Boolean(option.baseKey) : plan.ready) && !diskBlocks(need);
    const finalName = name.trim() || suggestedName;
    const ready = baseReady && finalName.length > 0;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (ready && !add.isPending) {
            cacheCheck.check(need?.size, option?.name ?? plan.name ?? "It", () => add.mutate());
        }
    };
    const shortcut = (event: KeyboardEvent<HTMLFormElement>) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            submit(event);
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
            <form
                onSubmit={submit}
                onKeyDown={shortcut}
                className="grid max-w-6xl items-start gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_16rem]"
            >
                <PanelSections>
                    <PanelSection
                        icon={Boxes}
                        title="Task and base model"
                        description="Recommendations follow the task."
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
                    >
                        <FieldGroup>
                            <TaskSelect value={task} onChange={setTask} />
                            <div className="flex flex-col gap-3">
                                <Field id="base-model" label="Base model">
                                    <BasePicker
                                        value={{
                                            option,
                                            importText:
                                                current?.kind === "import" ? current.text : null,
                                        }}
                                        catalog={catalog.data}
                                        models={rows}
                                        picks={picks}
                                        open={open}
                                        onOpenChange={setOpen}
                                        tab={tab}
                                        onTabChange={setTab}
                                        onPick={pick}
                                        onImport={importPick}
                                    />
                                </Field>
                                {catalog.isLoading && (
                                    <span className="text-sm text-muted-foreground">
                                        Loading the catalogue…
                                    </span>
                                )}
                                <ErrorLine error={catalog.error ?? startFrom.error} />
                                <BaseSummary
                                    option={option}
                                    plan={plan}
                                    catalog={catalog.data}
                                    need={need}
                                    accepted={accepted}
                                    onAccepted={setAccepted}
                                    onVariant={(variant) => {
                                        if (option?.entry) {
                                            setPicked({
                                                kind: "catalogue",
                                                id: option.entry.id,
                                                variant,
                                            });
                                            setAccepted(false);
                                        }
                                    }}
                                    copy={copy}
                                    onClearCopy={() => setCopy(null)}
                                    onPickAnother={() => setOpen(true)}
                                />
                            </div>
                        </FieldGroup>
                    </PanelSection>
                    <PanelSection icon={SquarePen} title="Details">
                        <FieldGroup>
                            <div className="grid gap-5 sm:grid-cols-2">
                                <Field
                                    id="create-name"
                                    label="Name"
                                    hint={`Apps call it as ${slugOf(finalName)}.`}
                                >
                                    <Input
                                        id="create-name"
                                        value={name}
                                        onChange={(event) => setName(event.target.value)}
                                        placeholder={suggestedName || "IT ticket classifier"}
                                    />
                                </Field>
                                <Field
                                    id="create-tags"
                                    label="Tags (optional)"
                                    hint="Comma separated."
                                >
                                    <Input
                                        id="create-tags"
                                        value={tags}
                                        onChange={(event) => setTags(event.target.value)}
                                    />
                                </Field>
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
                        </FieldGroup>
                    </PanelSection>
                </PanelSections>
                <aside className="lg:sticky lg:top-6 lg:pt-9">
                    <DiskPanel
                        option={option}
                        plan={plan}
                        need={need}
                        free={catalog.data?.store_free_bytes}
                    />
                </aside>
                <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 border-t bg-background py-3 lg:col-span-2">
                    <ErrorLine error={add.error} />
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
            {cacheCheck.dialog}
        </Page>
    );
}
