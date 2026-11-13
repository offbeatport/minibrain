import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import {
    Button,
    ConfirmDialog,
    Field,
    Input,
    Label,
    RadioGroup,
    RadioGroupItem,
    SettingsGroup,
    SettingsRow,
    Textarea,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { type ContractInfo, type GraderConfig, type ModelDetail, api, unwrap } from "~/api/client";
import { ErrorLine, PanelSection, errorMessage } from "~/components/Section";
import { useCan } from "~/lib/access";
import { contractSentence } from "~/lib/judging";
import { EXAMPLE_SCHEMA, schemaProblem, splitLabels } from "./TaskFields";

type Change = { path: string; detail: string; breaking: boolean };
type Part = "answer" | "rubric";

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

function RubricEditor({ detail, onDone }: { detail: ModelDetail; onDone: () => void }) {
    const [rubric, setRubric] = useState(detail.judge.rubric ?? detail.judge.default_rubric ?? "");
    const save = useMutation({
        mutationFn: (graders: GraderConfig[]) =>
            unwrap(
                api.PUT("/api/models/{name}/graders", {
                    params: { path: { name: detail.slug } },
                    body: { graders },
                }),
            ),
        ...useSaved("Rubric saved", onDone),
    });
    const configs: GraderConfig[] = detail.graders.map((item) =>
        item.name === JUDGE ? { name: JUDGE, rubric: rubric.trim() } : { name: item.name },
    );
    const unchanged = rubric.trim() === (detail.judge.rubric ?? detail.judge.default_rubric ?? "");
    return (
        <div className="flex flex-col gap-3">
            <Textarea
                id="judge-rubric"
                aria-label="Judge rubric"
                className="min-h-32"
                value={rubric}
                onChange={(event) => setRubric(event.target.value)}
            />
            <Actions>
                <Button
                    disabled={!rubric.trim() || unchanged || save.isPending}
                    onClick={() => save.mutate(configs)}
                >
                    Save
                </Button>
                <Button variant="ghost" onClick={onDone}>
                    Cancel
                </Button>
                <ErrorLine error={save.error} />
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
    const can = useCan();
    const [open, setOpen] = useState<Part | null>(null);
    const close = () => setOpen(null);
    const toggle = (part: Part) => () => setOpen(open === part ? null : part);
    const judged = detail.graders.some((item) => item.name === JUDGE);
    return (
        <PanelSection icon={Scale} anchor="how-its-judged" title="How it's judged">
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
                {judged && (
                    <JudgedRow
                        part="rubric"
                        label="Judge rubric"
                        description={detail.judge.rubric ?? detail.judge.default_rubric ?? ""}
                        open={open === "rubric"}
                        editable={can.build}
                        onToggle={toggle("rubric")}
                    >
                        <RubricEditor
                            key={JSON.stringify(detail.graders)}
                            detail={detail}
                            onDone={close}
                        />
                    </JudgedRow>
                )}
            </SettingsGroup>
        </PanelSection>
    );
}
