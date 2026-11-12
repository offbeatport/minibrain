import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import {
    Button,
    CheckboxSelect,
    ConfirmDialog,
    Field,
    Input,
    Label,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Textarea,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import {
    type ContractInfo,
    type GraderConfig,
    type ModelDetail,
    type PromotionInfo,
    api,
    unwrap,
} from "~/api/client";
import { useAllModels, useJudgeSetting, usePresets } from "~/api/queries";
import { ErrorLine, PanelSection, errorMessage } from "~/components/Section";
import { useCan } from "~/lib/access";
import { contractSentence, gradersSentence, judgeSentence, ruleSentence } from "~/lib/judging";
import {
    EXAMPLE_SCHEMA,
    PromotionEditor,
    metricsFor,
    schemaProblem,
    splitLabels,
} from "./TaskFields";

type Change = { path: string; detail: string; breaking: boolean };
type Part = "answer" | "graders" | "judge" | "rule";

const INSTALL_JUDGE = "install";
const JUDGE = "judge";

function useSaved(title: string, onDone: () => void) {
    const client = useQueryClient();
    const toast = useToast();
    return {
        onSuccess: async () => {
            await client.invalidateQueries();
            toast({ title, description: "The next version uses it.", tone: "success" as const });
            onDone();
        },
        onError: (error: unknown) =>
            toast({
                title: `${title.replace(" saved", "")} not saved`,
                description: errorMessage(error),
                tone: "destructive" as const,
            }),
    };
}

type AnswerKind = "text" | "labels" | "json";

const ANSWER_KINDS: { value: AnswerKind; label: string; description: string; noun: string }[] = [
    {
        value: "text",
        label: "Free text",
        description: "Any answer, over a conversation. A chat assistant.",
        noun: "a chat assistant",
    },
    {
        value: "labels",
        label: "One of these labels",
        description: "Exactly one label from a set, scored by accuracy. A classifier.",
        noun: "a classifier",
    },
    {
        value: "json",
        label: "A JSON schema",
        description: "JSON held to a schema you paste, scored field by field. A custom model.",
        noun: "a custom model",
    },
];

function answerKind(contract: ContractInfo): AnswerKind {
    if (contract.labels) {
        return "labels";
    }
    return contract.kind === "json" ? "json" : "text";
}

function startingLabels(detail: ModelDetail): string {
    const found = detail.contract.labels ?? detail.dataset_version?.labels ?? [];
    return found.join(", ");
}

function startingSchema(contract: ContractInfo): string {
    return contract.kind === "json" && !contract.labels
        ? JSON.stringify(contract.json_schema, null, 2)
        : EXAMPLE_SCHEMA;
}

function draftContract(kind: AnswerKind, labels: string, schema: string): ContractInfo | null {
    if (kind === "text") {
        return { kind: "text" };
    }
    if (kind === "labels") {
        const found = splitLabels(labels);
        return found.length >= 2 ? { kind: "json", labels: found } : null;
    }
    return schemaProblem(schema) ? null : { kind: "json", json_schema: JSON.parse(schema) };
}

function Actions({ children }: { children: ReactNode }) {
    return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function useContractChange(detail: ModelDetail, onSaved: (saved: ModelDetail) => void) {
    const slug = detail.slug;
    const [pending, setPending] = useState<{ contract: ContractInfo; changes: Change[] } | null>(
        null,
    );
    const save = useMutation({
        mutationFn: ({ contract, breaking }: { contract: ContractInfo; breaking: boolean }) =>
            unwrap(
                api.PUT("/api/models/{name}/contract", {
                    params: { path: { name: slug } },
                    body: { contract, breaking },
                }),
            ),
        onSuccess: onSaved,
    });
    const check = useMutation({
        mutationFn: (contract: ContractInfo) =>
            unwrap(
                api.POST("/api/models/{name}/contract/check", {
                    params: { path: { name: slug } },
                    body: contract,
                }),
            ),
        onSuccess: (found, contract) => {
            if (found.breaking) {
                setPending({ contract, changes: found.changes.filter((item) => item.breaking) });
            } else {
                save.mutate({ contract, breaking: false });
            }
        },
    });
    const confirm = (
        <ConfirmDialog
            open={pending !== null}
            onOpenChange={(open) => !open && setPending(null)}
            title="This is a breaking change"
            description={`${detail.name} has gone live, and apps that call it may stop working: ${(
                pending?.changes ?? []
            )
                .map((change) => `${change.path} ${change.detail}`)
                .join("; ")}. The next version serves the new answers.`}
            confirmLabel="Save the breaking change"
            destructive
            onConfirm={() =>
                pending
                    ? save.mutateAsync({ contract: pending.contract, breaking: true })
                    : undefined
            }
        />
    );
    return {
        change: (contract: ContractInfo) => check.mutate(contract),
        pending: check.isPending || save.isPending,
        error: check.error ?? save.error,
        confirm,
    };
}

function ContractEditor({ detail, onDone }: { detail: ModelDetail; onDone: () => void }) {
    const client = useQueryClient();
    const toast = useToast();
    const current = answerKind(detail.contract);
    const [kind, setKind] = useState<AnswerKind>(current);
    const [labels, setLabels] = useState(startingLabels(detail));
    const [schema, setSchema] = useState(startingSchema(detail.contract));
    const next = draftContract(kind, labels, schema);
    const initial = draftContract(current, startingLabels(detail), startingSchema(detail.contract));
    const problem =
        kind === "labels" && !next
            ? "At least two labels."
            : kind === "json"
              ? schemaProblem(schema)
              : undefined;
    const noun = ANSWER_KINDS.find((item) => item.value === kind)?.noun;
    const changer = useContractChange(detail, async (saved) => {
        await client.invalidateQueries();
        toast({
            title: "Answers saved",
            description:
                saved.preset === detail.preset
                    ? "The next version uses them."
                    : `${saved.name} is ${noun} now. The next version uses its answers.`,
            tone: "success",
        });
        onDone();
    });
    return (
        <div className="flex flex-col gap-3">
            <RadioGroup
                aria-label="Answers"
                value={kind}
                onValueChange={(value) =>
                    setKind(ANSWER_KINDS.find((item) => item.value === value)?.value ?? kind)
                }
                className="flex flex-col gap-3"
            >
                {ANSWER_KINDS.map((item) => (
                    <Label key={item.value} className="flex items-start gap-2 font-normal">
                        <RadioGroupItem value={item.value} className="mt-0.5" />
                        <span className="flex flex-col">
                            <span>{item.label}</span>
                            <span className="text-sm text-muted-foreground">
                                {item.description}
                            </span>
                        </span>
                    </Label>
                ))}
            </RadioGroup>
            {kind === "labels" && (
                <Field
                    id="contract-labels"
                    label="Labels"
                    error={problem}
                    hint="Separated by commas. Labels found in the data join the set on the next version."
                >
                    <Input
                        id="contract-labels"
                        value={labels}
                        placeholder="billing, bug, refund"
                        onChange={(event) => setLabels(event.target.value)}
                    />
                </Field>
            )}
            {kind === "json" && (
                <Field
                    id="contract-schema"
                    label="JSON schema"
                    error={problem}
                    hint="Every answer is decoded to match it. Adding optional fields later is free."
                >
                    <Textarea
                        id="contract-schema"
                        className="min-h-40 font-mono"
                        spellCheck={false}
                        value={schema}
                        onChange={(event) => setSchema(event.target.value)}
                    />
                </Field>
            )}
            <p className="text-sm text-muted-foreground">
                {detail.went_live
                    ? "It has gone live: removing or renaming what apps rely on, or switching the kind of answer, needs a confirmation."
                    : "Free to change until a version goes live."}
            </p>
            <Actions>
                <Button
                    disabled={
                        !next || JSON.stringify(next) === JSON.stringify(initial) || changer.pending
                    }
                    onClick={() => next && changer.change(next)}
                >
                    Save
                </Button>
                <Button variant="ghost" onClick={onDone}>
                    Cancel
                </Button>
                <ErrorLine error={changer.error} />
            </Actions>
            {changer.confirm}
        </div>
    );
}

function contractKind(contract: ContractInfo): string {
    return contract.labels ? "labels" : contract.kind;
}

function GradersEditor({ detail, onDone }: { detail: ModelDetail; onDone: () => void }) {
    const presets = usePresets();
    const [names, setNames] = useState(detail.graders.map((item) => item.name));
    const [rubric, setRubric] = useState(detail.judge.rubric ?? detail.judge.default_rubric ?? "");
    const kind = contractKind(detail.contract);
    const options = (presets.data?.graders ?? [])
        .filter((item) => item.contracts.includes(kind))
        .map((item) => ({ value: item.name, label: item.label }));
    const judged = names.includes(JUDGE);
    const save = useMutation({
        mutationFn: (graders: GraderConfig[]) =>
            unwrap(
                api.PUT("/api/models/{name}/graders", {
                    params: { path: { name: detail.slug } },
                    body: { graders },
                }),
            ),
        ...useSaved("Graders saved", onDone),
    });
    const configs: GraderConfig[] = [
        ...(judged ? [{ name: JUDGE, rubric: rubric.trim() }] : []),
        ...names.filter((name) => name !== JUDGE).map((name) => ({ name })),
    ];
    const unchanged =
        JSON.stringify(configs) ===
        JSON.stringify(
            detail.graders.map((item) =>
                item.name === JUDGE
                    ? { name: JUDGE, rubric: item.rubric ?? "" }
                    : { name: item.name },
            ),
        );
    const problem =
        names.length === 0
            ? "Pick at least one grader."
            : judged && !rubric.trim()
              ? "Write the rubric the judge scores against."
              : undefined;
    return (
        <div className="flex flex-col gap-3">
            <Field
                id="graders-picked"
                label="Graders"
                hint="The judge, when picked, comes first and gives the main score. Otherwise the first grader does."
            >
                <CheckboxSelect
                    label="Graders"
                    allLabel="No graders"
                    noun="graders"
                    options={options}
                    value={names}
                    onValueChange={setNames}
                />
            </Field>
            {judged && (
                <Field
                    id="judge-rubric"
                    label="Judge rubric"
                    hint="The judge scores each answer from 1 to 5 against this and says why in a sentence. Scores are cached per answer, rubric and judge."
                >
                    <Textarea
                        id="judge-rubric"
                        className="min-h-32"
                        value={rubric}
                        onChange={(event) => setRubric(event.target.value)}
                    />
                </Field>
            )}
            <Actions>
                <Button
                    disabled={Boolean(problem) || unchanged || save.isPending}
                    onClick={() => save.mutate(configs)}
                >
                    Save
                </Button>
                {!detail.graders_default && (
                    <Button
                        variant="outline"
                        disabled={save.isPending}
                        onClick={() => save.mutate([])}
                    >
                        Use the defaults
                    </Button>
                )}
                <Button variant="ghost" onClick={onDone}>
                    Cancel
                </Button>
                {problem && <span className="text-sm text-muted-foreground">{problem}</span>}
            </Actions>
        </div>
    );
}

function JudgeEditor({ detail, onDone }: { detail: ModelDetail; onDone: () => void }) {
    const models = useAllModels();
    const install = useJudgeSetting();
    const [value, setValue] = useState(detail.judge.override ?? INSTALL_JUDGE);
    const bases = (models.data ?? []).filter(
        (row) =>
            row.kind === "base" &&
            (row.availability.state === "available" || row.key === detail.judge.override),
    );
    const fallback = install.data?.name
        ? `This install's judge model, ${install.data.name}`
        : `This install's judge model (none chosen: its own base, ${detail.base_model})`;
    const save = useMutation({
        mutationFn: () =>
            unwrap(
                api.PUT("/api/models/{name}/judge", {
                    params: { path: { name: detail.slug } },
                    body: { model: value === INSTALL_JUDGE ? null : value },
                }),
            ),
        ...useSaved("Judge model saved", onDone),
    });
    return (
        <div className="flex flex-col gap-3">
            <Field
                id="judge-model"
                label="Judge model"
                hint="Any base on this install. A larger base judges better; the judge runs as its own job and its scores are cached."
            >
                <Select value={value} onValueChange={(next) => setValue(String(next ?? value))}>
                    <SelectTrigger id="judge-model" className="w-full max-w-md">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={INSTALL_JUDGE}>{fallback}</SelectItem>
                        {bases.map((row) => (
                            <SelectItem key={row.key} value={row.key}>
                                {row.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
            <Actions>
                <Button
                    disabled={save.isPending || value === (detail.judge.override ?? INSTALL_JUDGE)}
                    onClick={() => save.mutate()}
                >
                    Save
                </Button>
                <Button variant="ghost" onClick={onDone}>
                    Cancel
                </Button>
                <ErrorLine error={models.error ?? install.error} />
            </Actions>
        </div>
    );
}

function RuleEditor({
    detail,
    metrics,
    onDone,
}: {
    detail: ModelDetail;
    metrics: string[];
    onDone: () => void;
}) {
    const [rule, setRule] = useState<PromotionInfo>(detail.promotion);
    const save = useMutation({
        mutationFn: () =>
            unwrap(
                api.PUT("/api/models/{name}/promotion", {
                    params: { path: { name: detail.slug } },
                    body: rule,
                }),
            ),
        ...useSaved("Promotion rule saved", onDone),
    });
    const dirty = JSON.stringify(rule) !== JSON.stringify(detail.promotion);
    return (
        <div className="flex flex-col gap-3">
            <PromotionEditor
                id="model-promotion"
                value={rule}
                metrics={metrics}
                onChange={setRule}
            />
            <Actions>
                <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                    Save
                </Button>
                <Button variant="ghost" onClick={onDone}>
                    Cancel
                </Button>
            </Actions>
        </div>
    );
}

function JudgedRow({
    part,
    label,
    description,
    open,
    editable,
    onToggle,
    children,
}: {
    part: Part;
    label: string;
    description: ReactNode;
    open: boolean;
    editable: boolean;
    onToggle: () => void;
    children: ReactNode;
}) {
    return (
        <SettingsRow
            anchor={`judged-${part}`}
            label={label}
            description={description}
            control={
                editable ? (
                    <Button
                        variant="outline"
                        aria-expanded={open}
                        aria-controls={`judged-${part}-editor`}
                        onClick={onToggle}
                    >
                        {open ? "Close" : "Edit"}
                    </Button>
                ) : null
            }
        >
            {open && (
                <div id={`judged-${part}-editor`} className="pb-4">
                    {children}
                </div>
            )}
        </SettingsRow>
    );
}

export function JudgedSection({ detail }: { detail: ModelDetail }) {
    const presets = usePresets();
    const can = useCan();
    const [open, setOpen] = useState<Part | null>(null);
    const preset = presets.data?.presets.find((item) => item.key === detail.preset);
    const names = detail.graders.map((item) => item.name);
    const metrics = metricsFor(presets.data, names);
    const close = () => setOpen(null);
    const toggle = (part: Part) => () => setOpen(open === part ? null : part);
    const judgeShown = !detail.contract.labels && (detail.judge.used || Boolean(preset?.rubric));
    return (
        <PanelSection
            icon={Scale}
            anchor="how-its-judged"
            title="How it's judged"
            description={`What every answer is held to, how versions are scored and when one can go live. ${detail.graders_default ? `Each part starts from the ${preset?.label ?? detail.preset} defaults.` : "The graders are edited; the rest starts from the defaults."}`}
        >
            <SettingsGroup>
                <JudgedRow
                    part="answer"
                    label="Answers"
                    description={contractSentence(
                        detail.contract,
                        detail.contract_number,
                        detail.preset === "general",
                    )}
                    open={open === "answer"}
                    editable={can.build}
                    onToggle={toggle("answer")}
                >
                    <ContractEditor
                        key={JSON.stringify(detail.contract)}
                        detail={detail}
                        onDone={close}
                    />
                </JudgedRow>
                <JudgedRow
                    part="graders"
                    label="Scored by"
                    description={gradersSentence(names)}
                    open={open === "graders"}
                    editable={can.build}
                    onToggle={toggle("graders")}
                >
                    <GradersEditor
                        key={JSON.stringify(detail.graders)}
                        detail={detail}
                        onDone={close}
                    />
                </JudgedRow>
                {judgeShown && (
                    <JudgedRow
                        part="judge"
                        label="Judge"
                        description={
                            detail.judge.used || detail.judge.source !== "base"
                                ? judgeSentence(detail.judge)
                                : `${judgeSentence(detail.judge)} Pick one here, or for every model in Settings, General, to add a judge score.`
                        }
                        open={open === "judge"}
                        editable={can.build}
                        onToggle={toggle("judge")}
                    >
                        <JudgeEditor detail={detail} onDone={close} />
                    </JudgedRow>
                )}
                <JudgedRow
                    part="rule"
                    label="Goes live when"
                    description={ruleSentence(detail.promotion, metrics[0] ?? detail.main_metric)}
                    open={open === "rule"}
                    editable={can.build}
                    onToggle={toggle("rule")}
                >
                    <RuleEditor
                        key={JSON.stringify(detail.promotion)}
                        detail={detail}
                        metrics={metrics}
                        onDone={close}
                    />
                </JudgedRow>
            </SettingsGroup>
        </PanelSection>
    );
}
