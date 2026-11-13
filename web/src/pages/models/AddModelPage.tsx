import { useMutation } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { CubePlus, useToast } from "obp-ui";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type CatalogEntry, type DatasetSummary, type ModelRow, api, unwrap } from "~/api/client";
import { useAllModels, useCatalog, useDatasets } from "~/api/queries";
import { Breadcrumbs } from "~/components/Breadcrumbs";
import { CreateLayout, FormCard } from "~/components/CreateLayout";
import { FormControl, FormGroup, FormRow } from "~/components/FormRows";
import { PageHeader } from "~/components/PageHeader";
import { PickSelect } from "~/components/PickSelect";
import { ErrorLine, Page, errorMessage } from "~/components/Section";
import { type Identity, NameAvatarField, newIdentity } from "~/components/avatar/NameAvatarField";
import { avatarBody } from "~/components/avatar/avatarSvg";
import { generateName } from "~/lib/avatarNames";
import { count } from "~/lib/format";
import { modelPageHref } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import { bytes } from "~/lib/time";
import { AddModelSummary, Formats, Licence, servesOnlyOf } from "./AddModelSummary";
import { ApiNameHint } from "./ApiNameHint";
import { BasePicker, type PickerTab } from "./BasePicker";
import { type ImportPick, useSourcePlan } from "./BaseSource";
import { BaseSummary, diskBlocks, diskNeed } from "./BaseSummary";
import {
    type BaseOption,
    baseOptionFor,
    catalogueOption,
    recommend,
    servesOnly,
} from "./baseOptions";
import { useModelsRefresh } from "./dialogs";
import { FormatHelp } from "./formats";
import { isTaken, takenNames } from "./names";

type Problems = {
    model?: string;
    dataset?: string;
    name?: string;
    licence?: string;
};

const PROBLEM_ORDER: (keyof Problems)[] = ["model", "dataset", "name", "licence"];

const STARTING_PRESET = "general";

const UPLOAD_NEW = "upload-new";

const UPLOAD_HREF = "/data?add=1";

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

function heldOutOf(dataset: DatasetSummary | null): number | null {
    const counts = dataset?.dataset_version?.counts ?? dataset?.splits ?? null;
    return counts ? (counts.eval ?? 0) : null;
}

function datasetMeta(dataset: DatasetSummary): string {
    const number = dataset.dataset_version?.number;
    return [
        dataset.rows === null ? null : `${count(dataset.rows)} rows`,
        number ? `v${number}` : "no version",
    ]
        .filter(Boolean)
        .join(" · ");
}

function outcomeOf(dataset: DatasetSummary | null): string {
    const heldOut = heldOutOf(dataset);
    if (heldOut === null) {
        return "v0 · untrained baseline";
    }
    return `v0 · untrained baseline, scored on ${count(heldOut)} held-out rows`;
}

function DatasetPicker({
    value,
    datasets,
    invalid,
    onChange,
    onUpload,
}: {
    value: string | null;
    datasets: DatasetSummary[];
    invalid: boolean;
    onChange: (slug: string) => void;
    onUpload: () => void;
}) {
    return (
        <PickSelect
            id="create-dataset"
            value={value}
            placeholder="Pick a dataset"
            invalid={invalid}
            onChange={(next) => (next === UPLOAD_NEW ? onUpload() : onChange(next))}
            options={[
                ...datasets.map((dataset) => ({
                    value: dataset.slug,
                    label: dataset.name,
                    meta: datasetMeta(dataset),
                })),
                {
                    value: UPLOAD_NEW,
                    label: "Upload new…",
                    separated: datasets.length > 0,
                },
            ]}
        />
    );
}

export function AddModelPage() {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const toast = useToast();
    const params = useRouterState({ select: (state) => state.location.search as Search });
    const models = useAllModels();
    const catalog = useCatalog();
    const datasets = useDatasets();
    const [picked, setPicked] = useState<Picked | null>(() => initialPick(params));
    const [accepted, setAccepted] = useState(false);
    const [open, setOpen] = useState(params.source === "import");
    const [tab, setTab] = useState<PickerTab>(params.source === "import" ? "imports" : "catalogue");
    const [dataset, setDataset] = useState<string | null>(
        params.dataset === undefined ? null : String(params.dataset),
    );
    const entries = catalog.data?.entries ?? [];
    const rows = models.data ?? [];
    const datasetList = datasets.data ?? [];
    const chosenDataset = datasetList.find((item) => item.slug === dataset) ?? null;
    const picks = recommend(entries, rows, "general");
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
    const choose = (next: Picked) => {
        setPicked(next);
        setAccepted(false);
        setOpen(false);
    };
    const pick = (chosen: BaseOption) =>
        choose(
            chosen.entry
                ? { kind: "catalogue", id: chosen.entry.id, variant: chosen.variant?.id ?? "" }
                : { kind: "base", key: chosen.baseKey ?? "" },
        );
    const importPick = (found: ImportPick) => {
        if (found.kind === "catalogue") {
            choose({ kind: "catalogue", id: found.entry.id, variant: found.variant });
            setAccepted(found.accepted);
            return;
        }
        choose({ kind: "import", text: found.text, connection: found.connection });
    };
    const taken = takenNames(rows);
    const nameTaken = (candidate: string) => isTaken(candidate, taken);
    const [identity, setIdentity] = useState<Identity>(() => newIdentity(nameTaken));
    const firstName = useRef(identity.name);
    const loaded = models.isSuccess;
    useEffect(() => {
        if (loaded && identity.name === firstName.current && isTaken(identity.name, taken)) {
            const fresh = generateName((candidate) => isTaken(candidate, taken));
            firstName.current = fresh;
            setIdentity((current) => ({ ...current, name: fresh }));
        }
    }, [loaded, identity.name, taken]);
    const name = identity.name;
    const nameTouched = name !== firstName.current;
    const cancel = () => router.history.push(modelsHref());
    const add = useMutation({
        mutationFn: async (slug: string) => {
            const baseModel =
                option?.kind === "local" && option.baseKey ? option.baseKey : await plan.run();
            return unwrap(
                api.POST("/api/models", {
                    body: {
                        name: name.trim(),
                        base_model: baseModel || null,
                        preset: STARTING_PRESET,
                        dataset: slug,
                        avatar: avatarBody(identity.avatar),
                    },
                }),
            );
        },
        onError: (error) => {
            toast({
                title: "The model was not created",
                description: errorMessage(error),
                tone: "destructive",
            });
        },
        onSuccess: async (created) => {
            await refresh();
            toast({
                title: "Model created",
                description: need
                    ? `${created.name}. ${need.verb === "import" ? "Importing" : "Downloading"} ${option?.name ?? "the base model"} (${bytes(need.size)}) first.`
                    : servesOnly(option)
                      ? `${created.name}. Its base serves but can't be fine-tuned.`
                      : `${created.name}: v0 is being scored.`,
                tone: "success",
            });
            router.history.push(modelPageHref(created.slug));
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
        dataset: !dataset
            ? "Pick a dataset."
            : datasets.isSuccess && !chosenDataset
              ? `No dataset called ${dataset}. Pick another.`
              : undefined,
        name: !finalName
            ? "Name the model."
            : !/[A-Za-z0-9]/.test(finalName)
              ? "Use at least one letter or number."
              : isTaken(finalName, taken)
                ? `A model called ${finalName} already exists. Pick another name.`
                : undefined,
        licence: licencePending ? "Accept the licence to download this model." : undefined,
    };
    const blocked = PROBLEM_ORDER.map((field) => problems[field]).filter((text): text is string =>
        Boolean(text),
    );
    const ready = baseReady && blocked.length === 0 && Boolean(chosenDataset);
    const submit = () => {
        if (ready && chosenDataset && !add.isPending) {
            add.mutate(chosenDataset.slug);
        }
    };
    const shortcut = (event: KeyboardEvent<HTMLFormElement>) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
        }
    };
    const outcome = outcomeOf(chosenDataset);
    const showFormat = plan.target.kind === "catalogue" && Boolean(plan.variant);
    const form = (
        <FormCard>
            <FormGroup>
                <FormRow id="base-model" label="Base" align="start">
                    <FormControl>
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
                        {catalog.isLoading && (
                            <span className="text-sm text-muted-foreground">
                                Loading the catalogue…
                            </span>
                        )}
                        <ErrorLine error={catalog.error} />
                        <BaseSummary option={option} plan={plan} />
                    </FormControl>
                </FormRow>
                {showFormat && (
                    <FormRow id="create-format" label="Format" tip={<FormatHelp />}>
                        <FormControl>
                            <Formats
                                plan={plan}
                                variant={plan.variant ?? option?.variant ?? null}
                                servesOnly={servesOnlyOf(option, plan)}
                                onVariant={changeVariant}
                            />
                        </FormControl>
                    </FormRow>
                )}
                {option?.entry && (
                    <FormRow label="Licence" align="start">
                        <FormControl width="full">
                            <Licence
                                id="create-licence"
                                option={option}
                                plan={plan}
                                accepted={accepted}
                                onAccepted={setAccepted}
                            />
                        </FormControl>
                    </FormRow>
                )}
                <FormRow id="create-dataset" label="Dataset">
                    <FormControl>
                        <DatasetPicker
                            value={dataset}
                            datasets={datasetList}
                            invalid={Boolean(dataset) && Boolean(problems.dataset)}
                            onChange={setDataset}
                            onUpload={() => router.history.push(UPLOAD_HREF)}
                        />
                        <ErrorLine error={datasets.error} />
                    </FormControl>
                </FormRow>
                <FormRow id="create-name" label="Name" align="start">
                    <FormControl width="text">
                        <NameAvatarField
                            id="create-name"
                            labelled={false}
                            value={identity}
                            onChange={setIdentity}
                            taken={nameTaken}
                            error={nameTouched ? problems.name : undefined}
                        >
                            <ApiNameHint name={name} />
                        </NameAvatarField>
                    </FormControl>
                </FormRow>
            </FormGroup>
        </FormCard>
    );
    return (
        <Page>
            <Breadcrumbs
                items={[{ label: "Models", href: modelsHref() }, { label: "Add model" }]}
            />
            <PageHeader title="Add model" />
            <CreateLayout
                form={form}
                summary={
                    <AddModelSummary
                        option={option}
                        plan={plan}
                        need={need}
                        free={catalog.data?.store_free_bytes}
                        catalog={catalog.data}
                        outcome={outcome}
                        blocked={blocked}
                        onVariant={changeVariant}
                        onPickAnother={() => setOpen(true)}
                    />
                }
                submit={
                    <>
                        <CubePlus />
                        {add.isPending ? "Creating…" : "Create model"}
                    </>
                }
                disabled={!ready || add.isPending}
                status={blocked[0] ?? outcome}
                problem={blocked.length > 0}
                onSubmit={submit}
                onCancel={cancel}
                onKeyDown={shortcut}
            />
        </Page>
    );
}
