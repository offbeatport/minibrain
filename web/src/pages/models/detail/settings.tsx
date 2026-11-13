import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Gauge, Layers, ListChecks, Power, Settings2, TriangleAlert } from "lucide-react";
import {
    Button,
    Checkbox,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    useToast,
} from "obp-ui";
import { useState } from "react";
import {
    type GraderConfig,
    type ModelDetail,
    type ModelRow,
    type PromotionInfo,
    type VersionInfo,
    api,
    unwrap,
} from "~/api/client";
import { useAllModels, useJudgeSetting, usePresets } from "~/api/queries";
import { FormRow, FormRows } from "~/components/FormRows";
import { ErrorLine, PanelSection, PanelSections, errorMessage } from "~/components/Section";
import { TAGS_HINT, editableTags } from "~/components/Tags";
import { TestExamples } from "~/components/TestExamples";
import { ModelAvatar as AvatarImage } from "~/components/avatar/ModelAvatar";
import { useCan } from "~/lib/access";
import { JOBS_PATH, modelPageHref } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import { beingDeleted, busyTearingDown, deleteModel, rowId } from "~/lib/teardown";
import { ChangeAvatarDialog } from "../ChangeAvatarDialog";
import { DeleteModelsDialog } from "../DeleteModelsDialog";
import { DuplicateModelDialog } from "../DuplicateModelDialog";
import { AnswersRow, RubricRow } from "../JudgedRows";
import { SwitchBaseDialog } from "../SwitchBaseDialog";
import { PromotionEditor, metricsFor } from "../TaskFields";
import { ConfirmAction, type Confirmation, splitTags, useModelsRefresh } from "../dialogs";
import type { Entry } from "../entries";
import { DeploymentStatus, Tip, baseNameOf, deployConfirmation, isDeployed } from "./header";

const JUDGE = "judge";
const INSTALL_JUDGE = "install";

export const EVALUATION_ANCHOR = "evaluation";

function useReload(row: ModelRow) {
    const refresh = useModelsRefresh();
    const client = useQueryClient();
    return async () => {
        await refresh();
        await client.invalidateQueries({ queryKey: ["model", row.key] });
        await client.invalidateQueries({ queryKey: ["all-models", "page", row.key] });
    };
}

function sameList(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}

function General({ row }: { row: ModelRow }) {
    const toast = useToast();
    const reload = useReload(row);
    const can = useCan();
    const custom = row.kind === "custom";
    const [name, setName] = useState(row.name);
    const [description, setDescription] = useState(row.description);
    const [tags, setTags] = useState(editableTags(row.tags));
    const [picking, setPicking] = useState(false);
    const nextTags = splitTags(tags);
    const dirty =
        name.trim() !== row.name ||
        description.trim() !== row.description.trim() ||
        !sameList(nextTags, splitTags(editableTags(row.tags)));
    const locked = beingDeleted(row) || (!custom && !can.admin);
    const save = useMutation({
        mutationFn: () =>
            unwrap(
                api.PATCH("/api/models/{name}", {
                    params: { path: { name: row.key } },
                    body: { name: name.trim(), description: description.trim(), tags: nextTags },
                }),
            ),
        onSuccess: async () => {
            await reload();
            toast({ title: "Saved", description: name.trim(), tone: "success" });
        },
    });
    return (
        <PanelSection
            icon={Settings2}
            anchor="general"
            title="General"
            actions={
                <Button
                    variant="outline"
                    disabled={!dirty || !name.trim() || locked || save.isPending}
                    onClick={() => save.mutate()}
                >
                    Save
                </Button>
            }
        >
            <FormRows>
                <FormRow
                    id="settings-name"
                    label="Name"
                    tip={`Renaming keeps the API name ${row.key}; apps keep working.`}
                >
                    <Input
                        id="settings-name"
                        value={name}
                        readOnly={locked || save.isPending}
                        onChange={(event) => setName(event.target.value)}
                        className="w-full max-w-sm"
                    />
                </FormRow>
                {custom && (
                    <FormRow label="Avatar" align="start">
                        <AvatarImage name={row.name} avatar={row.avatar} size="xl" />
                        <Button
                            variant="outline"
                            disabled={locked}
                            onClick={() => setPicking(true)}
                        >
                            Change
                        </Button>
                    </FormRow>
                )}
                <FormRow id="settings-description" label="Description" align="start">
                    <Textarea
                        id="settings-description"
                        value={description}
                        rows={2}
                        readOnly={locked || save.isPending}
                        onChange={(event) => setDescription(event.target.value)}
                        className="w-full max-w-sm"
                    />
                </FormRow>
                <FormRow id="settings-tags" label="Tags" tip={TAGS_HINT}>
                    <Input
                        id="settings-tags"
                        value={tags}
                        placeholder="team:support, env:prod"
                        readOnly={locked || save.isPending}
                        onChange={(event) => setTags(event.target.value)}
                        className="w-full max-w-sm"
                    />
                </FormRow>
            </FormRows>
            <ErrorLine error={save.error} />
            {custom && <ChangeAvatarDialog row={row} open={picking} onOpenChange={setPicking} />}
        </PanelSection>
    );
}

function contractKind(detail: ModelDetail): string {
    return detail.contract.labels ? "labels" : detail.contract.kind;
}

function gradersBody(names: string[], detail: ModelDetail): GraderConfig[] {
    const rubric = (detail.judge.rubric ?? detail.judge.default_rubric ?? "").trim();
    return [
        ...(names.includes(JUDGE) ? [{ name: JUDGE, rubric }] : []),
        ...names.filter((name) => name !== JUDGE).map((name) => ({ name })),
    ];
}

function rescored(versions: VersionInfo[]): number {
    return versions.filter((version) => version.status === "ready" && version.score !== null)
        .length;
}

function versionsText(count: number): string {
    return count === 1 ? "1 version" : `${count} versions`;
}

function GraderChecks({
    options,
    value,
    onChange,
    disabled,
}: {
    options: { value: string; label: string }[];
    value: string[];
    onChange: (next: string[]) => void;
    disabled: boolean;
}) {
    return (
        <span className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {options.map((option) => (
                <Label key={option.value} className="flex items-center gap-2 font-normal">
                    <Checkbox
                        checked={value.includes(option.value)}
                        disabled={disabled}
                        onCheckedChange={(on) =>
                            onChange(
                                on === true
                                    ? [...value, option.value]
                                    : value.filter((item) => item !== option.value),
                            )
                        }
                    />
                    {option.label}
                </Label>
            ))}
        </span>
    );
}

function Evaluation({
    row,
    detail,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail;
    versions: VersionInfo[];
}) {
    const toast = useToast();
    const router = useRouter();
    const reload = useReload(row);
    const presets = usePresets();
    const models = useAllModels();
    const install = useJudgeSetting();
    const current = detail.graders.map((item) => item.name);
    const [names, setNames] = useState(current);
    const [judge, setJudge] = useState(detail.judge.override ?? INSTALL_JUDGE);
    const [rule, setRule] = useState<PromotionInfo>(detail.promotion);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const kind = contractKind(detail);
    const options = (presets.data?.graders ?? [])
        .filter((item) => item.contracts.includes(kind))
        .map((item) => ({ value: item.name, label: item.label }));
    const preset = presets.data?.presets.find((item) => item.key === detail.preset);
    const judgeShown =
        !detail.contract.labels &&
        (detail.judge.used || Boolean(preset?.rubric) || names.includes(JUDGE));
    const bases = (models.data ?? []).filter(
        (item) =>
            item.kind === "base" &&
            (item.availability.state === "available" || item.key === detail.judge.override),
    );
    const fallback = install.data?.name
        ? `Install default · ${install.data.name}`
        : `Install default · its base, ${baseNameOf(models.data, detail.base_model)}`;
    const gradersChanged = !sameList([...names].sort(), [...current].sort());
    const judgeChanged = judge !== (detail.judge.override ?? INSTALL_JUDGE);
    const ruleChanged = JSON.stringify(rule) !== JSON.stringify(detail.promotion);
    const scoring = gradersChanged || judgeChanged;
    const count = rescored(versions);
    const metrics = metricsFor(presets.data, names);
    const save = useMutation({
        mutationFn: async (rescore: boolean) => {
            const path = { params: { path: { name: row.key } } };
            if (gradersChanged) {
                await unwrap(
                    api.PUT("/api/models/{name}/graders", {
                        ...path,
                        body: { graders: gradersBody(names, detail) },
                    }),
                );
            }
            if (judgeChanged) {
                await unwrap(
                    api.PUT("/api/models/{name}/judge", {
                        ...path,
                        body: { model: judge === INSTALL_JUDGE ? null : judge },
                    }),
                );
            }
            if (ruleChanged) {
                await unwrap(api.PUT("/api/models/{name}/promotion", { ...path, body: rule }));
            }
            return rescore ? unwrap(api.POST("/api/models/{name}/rescore", path)) : null;
        },
        onSuccess: async (started) => {
            await reload();
            if (!started || started.versions.length === 0) {
                toast({ title: "Saved", tone: "success" });
                return;
            }
            toast({
                title: `Re-scoring ${versionsText(started.versions.length)}`,
                tone: "success",
                action: {
                    label: "View jobs",
                    onClick: () =>
                        router.history.push(
                            `${JOBS_PATH}?kind=eval&q=${encodeURIComponent(row.key)}`,
                        ),
                },
            });
        },
        onError: (error) =>
            toast({ title: "Not saved", description: errorMessage(error), tone: "destructive" }),
    });
    const submit = () => {
        if (!scoring || count === 0) {
            save.mutate(scoring);
            return;
        }
        setConfirmation({
            title: `Re-score ${versionsText(count)}?`,
            description: (
                <p>
                    {`Each scored version of ${row.name} runs on its held-out rows again, one job each, so versions stay comparable.`}
                </p>
            ),
            confirmLabel: "Save and re-score",
            run: () => save.mutateAsync(true),
        });
    };
    const blocked = names.length === 0;
    return (
        <PanelSection
            icon={Gauge}
            anchor={EVALUATION_ANCHOR}
            title="Evaluation"
            actions={
                <Button
                    variant="outline"
                    disabled={
                        (!scoring && !ruleChanged) || blocked || save.isPending || beingDeleted(row)
                    }
                    onClick={submit}
                >
                    {scoring && count > 0 ? "Save and re-score" : "Save"}
                </Button>
            }
        >
            <FormRows>
                <AnswersRow detail={detail} />
                <FormRow
                    label="Graders"
                    tip="The judge, when picked, comes first and gives the main score. Otherwise the first grader does."
                >
                    <GraderChecks
                        options={options}
                        value={names}
                        onChange={setNames}
                        disabled={save.isPending}
                    />
                    {blocked && (
                        <span className="text-sm text-muted-foreground">Pick at least one.</span>
                    )}
                </FormRow>
                {judgeShown && (
                    <FormRow
                        id="settings-judge"
                        label="Judge"
                        tip="Any base on this install. A larger base judges better; it runs as its own job and its scores are cached."
                    >
                        <Select
                            value={judge}
                            onValueChange={(next) => setJudge(String(next ?? judge))}
                        >
                            <SelectTrigger id="settings-judge" className="w-full max-w-64">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={INSTALL_JUDGE}>{fallback}</SelectItem>
                                {bases.map((item) => (
                                    <SelectItem key={item.key} value={item.key}>
                                        {item.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </FormRow>
                )}
                <RubricRow detail={detail} />
                <FormRow
                    id="settings-rule"
                    label="Promotion rule"
                    align="start"
                    tip="A version can be deployed only when every threshold holds on its held-out rows. Changing it does not re-score."
                >
                    <PromotionEditor
                        id="settings-rule"
                        value={rule}
                        metrics={metrics}
                        onChange={setRule}
                    />
                </FormRow>
            </FormRows>
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </PanelSection>
    );
}

function Deployment({ row }: { row: ModelRow }) {
    const reload = useReload(row);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const busy = busyTearingDown(row) ? (row.teardown?.label ?? "Busy") : null;
    return (
        <PanelSection icon={Power} anchor="deployment" title="Deployment">
            <FormRows>
                <FormRow label="Undeploy" detail={<DeploymentStatus row={row} />}>
                    <Tip tip={busy}>
                        <Button
                            variant="outline"
                            disabled={Boolean(busy)}
                            onClick={() => setConfirmation(deployConfirmation(row, true, reload))}
                        >
                            Undeploy
                        </Button>
                    </Tip>
                </FormRow>
            </FormRows>
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </PanelSection>
    );
}

function Danger({ row, detail }: { row: ModelRow; detail: ModelDetail | undefined }) {
    const router = useRouter();
    const can = useCan();
    const refresh = useModelsRefresh();
    const models = useAllModels();
    const [duplicating, setDuplicating] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [deleting, setDeleting] = useState<Entry[] | null>(null);
    const custom = row.kind === "custom";
    const moveTo = (detail?.serve_only ?? row.serve_only)?.switch_to ?? null;
    const gone = beingDeleted(row) ? "It is being deleted." : null;
    const deleteBlock =
        gone ?? (custom || can.admin ? null : "Only an admin can delete a base model.");
    return (
        <>
            {custom && (
                <PanelSection icon={Layers} anchor="base" title="Base and copies">
                    <FormRows>
                        {custom && (
                            <FormRow
                                label={moveTo ? `Move to ${moveTo.name}` : "Switch base"}
                                detail={`On ${baseNameOf(models.data, row.base_model)}`}
                            >
                                <Tip tip={gone}>
                                    <Button
                                        variant="outline"
                                        disabled={Boolean(gone)}
                                        onClick={() => setSwitching(true)}
                                    >
                                        {moveTo ? "Move" : "Switch base"}
                                    </Button>
                                </Tip>
                            </FormRow>
                        )}
                        {custom && (
                            <FormRow label="Duplicate" detail="Same settings, another dataset">
                                <Tip tip={gone}>
                                    <Button
                                        variant="outline"
                                        disabled={Boolean(gone)}
                                        onClick={() => setDuplicating(true)}
                                    >
                                        Duplicate
                                    </Button>
                                </Tip>
                            </FormRow>
                        )}
                    </FormRows>
                </PanelSection>
            )}
            <PanelSection icon={TriangleAlert} anchor="danger" title="Danger zone">
                <FormRows>
                    <FormRow
                        label="Delete"
                        detail={custom ? "With every version and key" : "With its files and keys"}
                    >
                        <Tip tip={deleteBlock}>
                            <Button
                                variant="destructive"
                                disabled={Boolean(deleteBlock)}
                                onClick={() =>
                                    setDeleting([{ key: rowId(row), model: row, version: null }])
                                }
                            >
                                Delete model
                            </Button>
                        </Tip>
                    </FormRow>
                </FormRows>
                {custom && (
                    <>
                        <DuplicateModelDialog
                            row={duplicating ? row : null}
                            onOpenChange={(open) => !open && setDuplicating(false)}
                        />
                        <SwitchBaseDialog
                            row={switching ? row : null}
                            preferred={moveTo?.key ?? null}
                            onOpenChange={(open) => !open && setSwitching(false)}
                        />
                    </>
                )}
                <DeleteModelsDialog
                    chosen={deleting}
                    rows={models.data ?? []}
                    onOpenChange={(open) => !open && setDeleting(null)}
                    onDelete={async (cascade, cancelJobs) => {
                        await deleteModel(row, { cascade, undeploy: true, cancelJobs });
                        await refresh();
                        router.history.push(modelsHref());
                    }}
                />
            </PanelSection>
        </>
    );
}

export function settingsHref(slug: string): string {
    return `${modelPageHref(slug, "settings")}#${EVALUATION_ANCHOR}`;
}

export function SettingsTab({
    row,
    detail,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const can = useCan();
    const custom = row.kind === "custom";
    return (
        <PanelSections>
            {(custom || can.admin) && <General key={row.updated_at} row={row} />}
            {custom && detail && (
                <Evaluation
                    key={JSON.stringify([detail.graders, detail.judge, detail.promotion])}
                    row={row}
                    detail={detail}
                    versions={versions}
                />
            )}
            {custom && can.build && (
                <PanelSection
                    icon={ListChecks}
                    anchor="test-examples"
                    title="Test examples"
                    tip="Saved from the Playground with the answer they should get. Each joins the held-out rows of the next version's data."
                    bare
                >
                    <TestExamples slug={row.key} />
                </PanelSection>
            )}
            {isDeployed(row) && <Deployment row={row} />}
            <Danger row={row} detail={detail} />
        </PanelSections>
    );
}
