import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { Button, ConfirmDialog, Field, Input, Textarea, useToast } from "obp-ui";
import { useState } from "react";
import {
    type ContractInfo,
    type MinibrainDetail,
    type PromotionInfo,
    api,
    unwrap,
} from "~/api/client";
import { usePresets } from "~/api/queries";
import { ErrorLine, PanelSection, errorMessage } from "~/components/Section";
import { useCan } from "~/lib/access";
import { metricName } from "~/lib/metrics";
import { PromotionEditor, metricsFor, schemaProblem, splitLabels } from "./TaskFields";

type Change = { path: string; detail: string; breaking: boolean };

function contractText(contract: ContractInfo): string {
    if (contract.labels) {
        return contract.labels.join(", ");
    }
    return contract.kind === "json" ? JSON.stringify(contract.json_schema, null, 2) : "";
}

function draftContract(contract: ContractInfo, text: string): ContractInfo | null {
    if (contract.labels) {
        const labels = splitLabels(text);
        return labels.length >= 2 ? { kind: "json", labels } : null;
    }
    return schemaProblem(text) ? null : { kind: "json", json_schema: JSON.parse(text) };
}

function ContractEditor({ detail }: { detail: MinibrainDetail }) {
    const client = useQueryClient();
    const toast = useToast();
    const slug = detail.slug;
    const [text, setText] = useState(contractText(detail.contract));
    const [pending, setPending] = useState<Change[] | null>(null);
    const next = draftContract(detail.contract, text);
    const problem = detail.contract.labels
        ? next
            ? undefined
            : "At least two labels."
        : schemaProblem(text);
    const save = useMutation({
        mutationFn: (breaking: boolean) =>
            unwrap(
                api.PUT("/api/minibrains/{slug}/contract", {
                    params: { path: { slug } },
                    body: { contract: next ?? detail.contract, breaking },
                }),
            ),
        onSuccess: async () => {
            setPending(null);
            await client.invalidateQueries();
            toast({
                title: "Contract saved",
                description: "The next version uses it.",
                tone: "success",
            });
        },
        onError: (error) =>
            toast({
                title: "The contract was not saved",
                description: errorMessage(error),
                tone: "destructive",
            }),
    });
    const check = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/minibrains/{slug}/contract/check", {
                    params: { path: { slug } },
                    body: next ?? detail.contract,
                }),
            ),
        onSuccess: (found) => {
            if (found.breaking) {
                setPending(found.changes.filter((change) => change.breaking));
            } else {
                save.mutate(false);
            }
        },
    });
    if (detail.contract.kind === "text") {
        return <p className="text-base">Free text, checked by the graders.</p>;
    }
    const label = detail.contract.labels ? "Labels" : "JSON schema";
    return (
        <div className="flex flex-col gap-3">
            <Field
                id="contract-text"
                label={`${label} · contract ${detail.contract_number}`}
                error={problem}
                hint="Adding labels or optional fields is free. Removing or renaming any needs a confirmation, because apps depend on them."
            >
                {detail.contract.labels ? (
                    <Input
                        id="contract-text"
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                    />
                ) : (
                    <Textarea
                        id="contract-text"
                        className="min-h-40 font-mono"
                        spellCheck={false}
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                    />
                )}
            </Field>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    variant="outline"
                    disabled={
                        !next ||
                        text === contractText(detail.contract) ||
                        check.isPending ||
                        save.isPending
                    }
                    onClick={() => check.mutate()}
                >
                    Save contract
                </Button>
                <ErrorLine error={check.error} />
            </div>
            <ConfirmDialog
                open={pending !== null}
                onOpenChange={(open) => !open && setPending(null)}
                title="This is a breaking change"
                description={`Apps that call ${detail.name} may stop working: ${(pending ?? [])
                    .map((change) => `${change.path} ${change.detail}`)
                    .join("; ")}. The next version serves the new contract.`}
                confirmLabel="Save the breaking change"
                destructive
                onConfirm={() => save.mutateAsync(true)}
            />
        </div>
    );
}

function RuleEditor({ detail, metrics }: { detail: MinibrainDetail; metrics: string[] }) {
    const client = useQueryClient();
    const toast = useToast();
    const [rule, setRule] = useState<PromotionInfo>(detail.promotion);
    const save = useMutation({
        mutationFn: () =>
            unwrap(
                api.PUT("/api/minibrains/{slug}/promotion", {
                    params: { path: { slug: detail.slug } },
                    body: rule,
                }),
            ),
        onSuccess: async () => {
            await client.invalidateQueries();
            toast({ title: "Promotion rule saved", tone: "success" });
        },
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
            {dirty && (
                <div className="flex flex-wrap items-center gap-2">
                    <Button disabled={save.isPending} onClick={() => save.mutate()}>
                        Save rule
                    </Button>
                    <Button variant="ghost" onClick={() => setRule(detail.promotion)}>
                        Cancel
                    </Button>
                    <ErrorLine error={save.error} />
                </div>
            )}
        </div>
    );
}

export function TaskSection({ detail }: { detail: MinibrainDetail }) {
    const presets = usePresets();
    const can = useCan();
    const preset = presets.data?.presets.find((item) => item.key === detail.preset);
    const metrics = metricsFor(
        presets.data,
        detail.graders.map((item) => item.name),
    );
    return (
        <PanelSection
            icon={ListChecks}
            title="Task"
            description={`${preset?.label ?? detail.preset}: the contract every answer is held to, the graders that score versions, and the rule a version passes to go live.`}
        >
            <div className="flex flex-col gap-field">
                {can.build ? (
                    <ContractEditor key={JSON.stringify(detail.contract)} detail={detail} />
                ) : (
                    <pre className="whitespace-pre-wrap font-mono text-sm">
                        {contractText(detail.contract)}
                    </pre>
                )}
                <div className="flex flex-col gap-label">
                    <span className="text-sm font-medium">Graders</span>
                    <p className="text-base">
                        {metrics.length > 0
                            ? metrics.map((metric) => metricName(metric)).join(", ")
                            : "–"}
                        <span className="text-muted-foreground">
                            {metrics[0]
                                ? ` · main metric ${metricName(metrics[0]).toLowerCase()}`
                                : ""}
                        </span>
                    </p>
                </div>
                {can.build && (
                    <RuleEditor
                        key={JSON.stringify(detail.promotion)}
                        detail={detail}
                        metrics={metrics}
                    />
                )}
            </div>
        </PanelSection>
    );
}
