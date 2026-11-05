import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, X } from "lucide-react";
import { Button, Card, CubePlus, Field, InfoTip, Input, Link, Textarea, useToast } from "obp-ui";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { type CatalogEntry, type ModelRow, type PresetsResponse, api, unwrap } from "~/api/client";
import { keys, useAllModels, useCatalog, usePresets } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, errorMessage } from "~/components/Section";
import { TagsHelp } from "~/components/Tags";
import { modelsHref } from "~/lib/modelsSearch";
import { bytes } from "~/lib/time";
import { AddModelSummary, Licence } from "./AddModelSummary";
import { BasePicker, type PickerTab } from "./BasePicker";
import { type ImportPick, useSourcePlan } from "./BaseSource";
import { BaseSummary, type CopySource, diskBlocks, diskNeed } from "./BaseSummary";
import {
    ClassifyFields,
    CustomFields,
    EMPTY_TASK,
    PresetSelect,
    PromotionEditor,
    type TaskDraft,
    contractOf,
    defaultGraders,
    graderConfigs,
    metricsFor,
    schemaProblem,
    splitLabels,
} from "./TaskFields";
import {
    type BaseOption,
    type TaskKey,
    baseOptionFor,
    catalogueOption,
    recommend,
    servesOnly,
} from "./baseOptions";
import { splitTags, useModelsRefresh } from "./dialogs";

type Problems = {
    model?: string;
    name?: string;
    labels?: string;
    schema?: string;
    graders?: string;
    rubric?: string;
    licence?: string;
};

const PROBLEM_ORDER: (keyof Problems)[] = [
    "model",
    "name",
    "labels",
    "schema",
    "graders",
    "rubric",
    "licence",
];

const PROBLEM_TARGETS: Record<keyof Problems, string> = {
    model: "base-model",
    name: "create-name",
    labels: "create-labels",
    schema: "create-schema",
    graders: "create-graders",
    rubric: "create-rubric",
    licence: "create-licence",
};

const NOUNS: Record<string, string> = { classify: "Classifier", custom: "Custom" };

function offered(found: PresetsResponse | undefined): PresetsResponse | undefined {
    return found && { ...found, presets: found.presets.filter((item) => item.key in NOUNS) };
}

function takenNames(rows: ModelRow[]): Set<string> {
    return new Set(
        rows.flatMap((row) => [
            row.name.trim().toLowerCase(),
            row.key.toLowerCase(),
            slugOf(row.key),
        ]),
    );
}

function isTaken(name: string, taken: Set<string>): boolean {
    return taken.has(name.trim().toLowerCase()) || taken.has(slugOf(name));
}

function nextFree(noun: string, taken: Set<string>, numbered = true): string {
    for (let number = 1; number < 10_000; number++) {
        const candidate = number === 1 && !numbered ? noun : `${noun} ${number}`;
        if (!isTaken(candidate, taken)) {
            return candidate;
        }
    }
    return noun;
}

function slugOf(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48)
        .replace(/-+$/, "");
}

function Optional({ label }: { label: string }) {
    return (
        <span>
            {label} <span className="font-normal text-faint">(optional)</span>
        </span>
    );
}

type Picked =
    | { kind: "base"; key: string }
    | { kind: "catalogue"; id: string; variant: string }
    | { kind: "import"; text: string; connection: number | null };

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
    return value === "custom" ? "custom" : "classify";
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

export function AddModelPage() {
    const router = useRouter();
    const client = useQueryClient();
    const refresh = useModelsRefresh();
    const toast = useToast();
    const params = useRouterState({ select: (state) => state.location.search as Search });
    const models = useAllModels();
    const catalog = useCatalog();
    const presets = offered(usePresets().data);
    const [task, setTaskKey] = useState<TaskKey>("classify");
    const [draft, setDraft] = useState<TaskDraft>(EMPTY_TASK);
    const [nameEdited, setNameEdited] = useState(false);
    const [picked, setPicked] = useState<Picked | null>(() => initialPick(params));
    const [accepted, setAccepted] = useState(false);
    const [checked, setChecked] = useState(false);
    const [open, setOpen] = useState(params.source === "import");
    const [tab, setTab] = useState<PickerTab>(params.source === "import" ? "import" : "catalogue");
    const [copy, setCopy] = useState<CopySource | null>(null);
    const [typedName, setName] = useState("");
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
        connection: current?.kind === "import" ? current.connection : null,
    });
    const need = diskNeed(option, plan, catalog.data?.store_free_bytes);
    const setTask = (next: TaskKey) => {
        setTaskKey(next);
        const graders = defaultGraders(presets, next, draft);
        setDraft({ ...draft, graders: next === "custom" ? graders : [] });
    };
    const startFrom = useMutation({
        mutationFn: async (row: ModelRow) => {
            const path = { params: { path: { slug: row.key } } };
            const [detail, versions] = await Promise.all([
                client.fetchQuery({
                    queryKey: keys.model(row.key),
                    queryFn: () => unwrap(api.GET("/api/models/{slug}", path)),
                }),
                client.fetchQuery({
                    queryKey: keys.versions(row.key),
                    queryFn: () => unwrap(api.GET("/api/models/{slug}/versions", path)),
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
            setTask(taskOf(detail.preset));
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
            setDescription(chosen.custom.description ?? "");
            setTags((chosen.custom.tags ?? []).join(", "));
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
        choose({ kind: "import", text: found.text, connection: found.connection });
    };
    const taken = takenNames(rows);
    const suggestedName = copy
        ? nextFree(`${copy.name} copy`, taken, false)
        : nextFree(NOUNS[task] ?? "Model", taken);
    const name = nameEdited ? typedName : suggestedName;
    const baseKey =
        option?.kind === "local" && option.baseKey ? option.baseKey : (option?.entry?.id ?? "");
    const labels = splitLabels(draft.labels);
    const graders = graderConfigs(task, draft, baseKey);
    const metrics =
        task === "classify"
            ? metricsFor(presets, ["label_accuracy"])
            : metricsFor(presets, draft.graders);
    const bases = rows
        .filter((row) => row.kind === "base")
        .map((row) => ({ key: row.key, name: row.name }));
    const add = useMutation({
        mutationFn: async () => {
            const baseModel =
                option?.kind === "local" && option.baseKey ? option.baseKey : await plan.run();
            return unwrap(
                api.POST("/api/models", {
                    body: {
                        name: name.trim(),
                        description: description.trim(),
                        tags: splitTags(tags),
                        base_model: baseModel || null,
                        preset: task === "custom" ? "custom" : "classify",
                        labels,
                        contract: contractOf(task, draft),
                        instructions: draft.instructions.trim() || null,
                        graders,
                        promotion: draft.promotion,
                        dataset: dataset || null,
                    },
                }),
            );
        },
        onError: (error) => {
            toast({
                title: "The model was not added",
                description: errorMessage(error),
                tone: "destructive",
            });
        },
        onSuccess: async (created) => {
            await refresh();
            toast({
                title: "Model added",
                description: need
                    ? `${created.name}. ${need.verb === "import" ? "Importing" : "Downloading"} ${option?.name ?? "the base model"} (${bytes(need.size)}) first.`
                    : servesOnly(option)
                      ? `${created.name}. Its base serves but can't be fine-tuned.`
                      : `${created.name}: v0 is ready to try in the Playground.`,
                tone: "success",
            });
            router.history.push(modelsHref());
        },
    });
    const baseReady =
        (option?.kind === "local" ? Boolean(option.baseKey) : plan.ready) && !diskBlocks(need);
    const finalName = name.trim();
    const changeVariant = (variant: string) => {
        if (option?.entry) {
            setPicked({ kind: "catalogue", id: option.entry.id, variant });
            setAccepted(false);
        }
    };
    const licencePending =
        plan.target.kind === "catalogue" && !plan.installedKey && !plan.blocked && !accepted;
    const problems: Problems = {
        model:
            !option && current?.kind !== "import"
                ? "Pick a base model."
                : plan.blocked && !plan.installedKey
                  ? plan.blocked
                  : diskBlocks(need)
                    ? "Not enough disk space for this model. Free some space or pick a smaller one."
                    : current?.kind === "import" && !plan.ready && !licencePending
                      ? "Check the import location first."
                      : undefined,
        name: !finalName
            ? "Name the model."
            : !/[A-Za-z0-9]/.test(finalName)
              ? "Use at least one letter or number."
              : isTaken(finalName, taken)
                ? `A model called ${finalName} already exists. Pick another name.`
                : undefined,
        labels:
            task === "classify" && !dataset && labels.length < 2
                ? "Add at least two labels, or pick a dataset."
                : undefined,
        schema:
            task === "custom" && draft.answer === "json" ? schemaProblem(draft.schema) : undefined,
        graders:
            task === "custom" && draft.graders.length === 0
                ? "Pick at least one grader."
                : undefined,
        rubric:
            task === "custom" && draft.graders.includes("judge") && !draft.rubric.trim()
                ? "Write the rubric the judge scores against."
                : undefined,
        licence: licencePending ? "Accept the licence to download this model." : undefined,
    };
    const shown = checked ? problems : {};
    const ready = baseReady && PROBLEM_ORDER.every((field) => !problems[field]);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        setChecked(true);
        const first = PROBLEM_ORDER.find((field) => problems[field]);
        if (first) {
            const target = document.getElementById(PROBLEM_TARGETS[first]);
            target?.scrollIntoView({ block: "center", behavior: "smooth" });
            target?.focus({ preventScroll: true });
            return;
        }
        if (ready && !add.isPending) {
            add.mutate();
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
                caption="Pick a task, a base model and a name. Version 0 answers at once with a prompt; train later from its page."
            />
            <form
                onSubmit={submit}
                onKeyDown={shortcut}
                className="grid max-w-5xl items-start gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-stretch"
            >
                <Card className="gap-field p-panel">
                    <PresetSelect
                        presets={presets}
                        value={task}
                        onChange={(next) => setTask(taskOf(next))}
                    />
                    <div className="flex flex-col gap-3">
                        <Field id="base-model" label="Model" error={shown.model}>
                            <BasePicker
                                value={{
                                    option,
                                    importText: current?.kind === "import" ? current.text : null,
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
                            copy={copy}
                            onClearCopy={() => setCopy(null)}
                        />
                    </div>
                    <Field
                        id="create-name"
                        label="Name"
                        error={problems.name && (checked || nameEdited) ? problems.name : undefined}
                    >
                        <Input
                            id="create-name"
                            required
                            aria-invalid={Boolean(problems.name && (checked || nameEdited))}
                            value={name}
                            onChange={(event) => {
                                setNameEdited(true);
                                setName(event.target.value);
                            }}
                        />
                    </Field>
                    {task === "classify" ? (
                        <ClassifyFields
                            draft={draft}
                            onChange={setDraft}
                            found={[]}
                            error={shown.labels}
                        />
                    ) : (
                        <CustomFields
                            draft={draft}
                            onChange={setDraft}
                            presets={presets}
                            bases={bases}
                            base={baseKey}
                            problems={shown}
                        />
                    )}
                    <PromotionEditor
                        id="create-promotion"
                        value={draft.promotion}
                        metrics={metrics}
                        onChange={(promotion) => setDraft({ ...draft, promotion })}
                    />
                    <Field id="create-description" label={<Optional label="Description" />}>
                        <Textarea
                            id="create-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            className="min-h-32"
                            placeholder="Routes incoming tickets to the right queue"
                        />
                    </Field>
                    <Field
                        id="create-tags"
                        label={
                            <span className="flex items-center gap-1.5">
                                <Optional label="Tags" />
                                <InfoTip label="How tags help">
                                    <TagsHelp />
                                </InfoTip>
                            </span>
                        }
                    >
                        <Input
                            id="create-tags"
                            value={tags}
                            onChange={(event) => setTags(event.target.value)}
                        />
                    </Field>
                    {option?.entry && (
                        <div className="flex flex-col gap-label">
                            <span className="text-sm font-medium">Licence</span>
                            <Licence
                                id="create-licence"
                                option={option}
                                plan={plan}
                                accepted={accepted}
                                onAccepted={setAccepted}
                                error={shown.licence}
                            />
                        </div>
                    )}
                </Card>
                <aside className="flex flex-col">
                    <AddModelSummary
                        option={option}
                        plan={plan}
                        need={need}
                        free={catalog.data?.store_free_bytes}
                        catalog={catalog.data}
                        onVariant={changeVariant}
                        onPickAnother={() => setOpen(true)}
                    />
                </aside>
                <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4 lg:col-span-2">
                    <ErrorLine error={add.error} />
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => router.history.push(modelsHref())}
                    >
                        <X />
                        Cancel
                    </Button>
                    <Button type="submit" disabled={add.isPending}>
                        <CubePlus />
                        {add.isPending ? "Adding…" : "Add model"}
                    </Button>
                </div>
            </form>
        </Page>
    );
}
