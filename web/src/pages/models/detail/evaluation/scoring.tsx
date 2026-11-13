import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Scale } from "lucide-react";
import {
    Button,
    Checkbox,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
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
import { PanelSection, errorMessage } from "~/components/Section";
import { JOBS_PATH } from "~/lib/modelLinks";
import { beingDeleted } from "~/lib/teardown";
import { AnswersRow, RubricRow } from "../../JudgedRows";
import { PromotionEditor, metricsFor } from "../../TaskFields";
import { ConfirmAction, type Confirmation } from "../../dialogs";
import { baseNameOf } from "../header";
import { sameList, useReload } from "../settings";

const JUDGE = "judge";
const INSTALL_JUDGE = "install";

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

export function ScoringPanel({
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
            icon={Scale}
            anchor="scoring"
            title="How it's scored"
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
                        id="scoring-judge"
                        label="Judge"
                        tip="Any base on this install. A larger base judges better; it runs as its own job and its scores are cached."
                    >
                        <Select
                            value={judge}
                            onValueChange={(next) => setJudge(String(next ?? judge))}
                        >
                            <SelectTrigger id="scoring-judge" className="w-full max-w-64">
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
                    id="scoring-rule"
                    label="Promotion rule"
                    align="start"
                    tip="A version can be deployed only when every threshold holds on its held-out rows. Changing it does not re-score."
                >
                    <PromotionEditor
                        id="scoring-rule"
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
