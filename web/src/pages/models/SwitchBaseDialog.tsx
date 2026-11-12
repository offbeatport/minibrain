import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Label,
    RadioGroup,
    RadioGroupItem,
    useToast,
} from "obp-ui";
import { useState } from "react";
import { type BaseChoice, type BaseOptions, type ModelRow, api, unwrap } from "~/api/client";
import { ErrorLine } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import { Licence } from "./AddModelSummary";
import { useSourcePlan } from "./BaseSource";

const KEPT =
    "Its name, API address and keys, instructions, answers, graders, promotion rule, training data, feedback and test examples stay. New versions are made on the base you pick, starting with a prompt-only version that is scored at once.";

const CARD =
    "flex cursor-pointer rounded-lg border px-3 py-2.5 font-normal leading-snug hover:bg-secondary has-[[data-checked]]:border-primary has-[[data-checked]]:bg-accent has-[[data-disabled]]:cursor-default has-[[data-disabled]]:opacity-60 has-[[data-disabled]]:hover:bg-transparent";

export function useBaseOptions(slug: string, enabled: boolean) {
    return useQuery({
        queryKey: ["model", slug, "base-options"],
        queryFn: () =>
            unwrap(
                api.GET("/api/models/{name}/base-options", { params: { path: { name: slug } } }),
            ),
        enabled,
    });
}

function nameOf(options: BaseOptions | undefined, key: string): string {
    if (options?.switch_to?.key === key) {
        return options.switch_to.name;
    }
    return options?.choices.find((choice) => choice.key === key)?.name ?? key;
}

function liveText(row: ModelRow, options: BaseOptions | undefined): string {
    const live = (row.versions ?? []).find((version) => version.live);
    const current = nameOf(options, row.base_model ?? "");
    if (live) {
        return `v${live.number} stays live on ${nameOf(options, live.base_model ?? "")} until you deploy a version made on the new base. Versions made on ${current} stay as history and can't be deployed after the switch.`;
    }
    if (row.deployment.state !== "not_deployed") {
        return `${row.key} keeps answering with ${current} until you deploy a version made on the new base.`;
    }
    return `Nothing is deployed, so no traffic changes. Versions made on ${current} stay as history.`;
}

function ChoiceCard({ choice }: { choice: BaseChoice }) {
    const id = `base-${choice.key}`;
    const facts = [
        choice.serve_only ? `Serve only · ${choice.serve_only}` : "Trainable",
        choice.state === "pending" ? "Downloading" : null,
    ].filter(Boolean);
    return (
        <Label htmlFor={id} className={CARD}>
            <span className="flex min-w-0 flex-1 items-start gap-2">
                <RadioGroupItem
                    value={choice.key}
                    id={id}
                    disabled={choice.current || Boolean(choice.refusal)}
                    className="mt-0.5"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2 font-medium">
                        {choice.name}
                        {choice.current && <Badge variant="outline">Current</Badge>}
                    </span>
                    <span className="text-sm text-muted-foreground">{facts.join(" · ")}</span>
                    {choice.refusal && (
                        <span className="text-sm text-muted-foreground">{choice.refusal}</span>
                    )}
                    {choice.warnings.map((warning) => (
                        <StatusText key={warning} tone="warning" className="whitespace-normal">
                            {warning}
                        </StatusText>
                    ))}
                </span>
            </span>
        </Label>
    );
}

function DownloadCard({ options }: { options: BaseOptions }) {
    const target = options.switch_to;
    if (!target || target.installed) {
        return null;
    }
    const id = `base-${target.key}`;
    return (
        <Label htmlFor={id} className={CARD}>
            <span className="flex min-w-0 flex-1 items-start gap-2">
                <RadioGroupItem value={target.key} id={id} className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2 font-medium">
                        {target.name}
                        <Badge variant="outline">Not on this install</Badge>
                    </span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {`Trainable · Downloads ${bytes(target.size_bytes)}`}
                    </span>
                </span>
            </span>
        </Label>
    );
}

function firstPick(options: BaseOptions | undefined, preferred: string | null): string {
    const open = (options?.choices ?? []).filter((choice) => !choice.current && !choice.refusal);
    const keys = [...open.map((choice) => choice.key), options?.switch_to?.key].filter(Boolean);
    if (preferred && keys.includes(preferred)) {
        return preferred;
    }
    const target = options?.switch_to?.key;
    return target && keys.includes(target) ? target : (open[0]?.key ?? "");
}

export function SwitchBaseDialog({
    row,
    preferred,
    onOpenChange,
}: {
    row: ModelRow | null;
    preferred?: string | null;
    onOpenChange: (open: boolean) => void;
}) {
    const client = useQueryClient();
    const toast = useToast();
    const options = useBaseOptions(row?.key ?? "", row !== null);
    const [picked, setPicked] = useState<string | null>(null);
    const [accepted, setAccepted] = useState(false);
    const chosen = picked ?? firstPick(options.data, preferred ?? null);
    const target = options.data?.switch_to;
    const downloading = Boolean(target && !target.installed && chosen === target.key);
    const plan = useSourcePlan({
        text: downloading && target ? target.catalog_id : "",
        variant: downloading && target ? target.variant_id : "",
        accepted,
        connection: null,
    });
    const switching = useMutation({
        mutationFn: async (source: ModelRow) => {
            const base = downloading ? await plan.run() : chosen;
            return unwrap(
                api.POST("/api/models/{name}/base", {
                    params: { path: { name: source.key } },
                    body: { base_model: base },
                }),
            );
        },
        onSuccess: async (detail) => {
            close();
            toast({
                title: "Base switched",
                description: `${detail.name} is on ${nameOf(options.data, detail.base_model ?? "")} now.`,
                tone: "success",
            });
            await client.invalidateQueries();
        },
    });
    const close = () => {
        setPicked(null);
        setAccepted(false);
        switching.reset();
        onOpenChange(false);
    };
    const choices = options.data?.choices ?? [];
    const blocked = downloading && !plan.ready;
    return (
        <Dialog open={row !== null} onOpenChange={(open) => !open && close()}>
            <DialogContent className="sm:max-w-xl">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (row && chosen && !blocked && !switching.isPending) {
                            switching.mutate(row);
                        }
                    }}
                    className="contents"
                >
                    <DialogHeader>
                        <DialogTitle>{`Switch the base of ${row?.name ?? ""}`}</DialogTitle>
                        <DialogDescription>{KEPT}</DialogDescription>
                    </DialogHeader>
                    {options.isLoading ? (
                        <p className="text-muted-foreground">Loading the bases…</p>
                    ) : (
                        <RadioGroup
                            aria-label="Base"
                            value={chosen}
                            onValueChange={(value) => {
                                setPicked(String(value));
                                setAccepted(false);
                            }}
                            className="max-h-80 gap-2 overflow-y-auto"
                        >
                            {options.data && <DownloadCard options={options.data} />}
                            {choices.map((choice) => (
                                <ChoiceCard key={choice.key} choice={choice} />
                            ))}
                        </RadioGroup>
                    )}
                    {downloading && (
                        <div className="flex flex-col gap-label">
                            <span className="font-medium">Licence</span>
                            <Licence
                                id="switch-licence"
                                option={null}
                                plan={plan}
                                accepted={accepted}
                                onAccepted={setAccepted}
                            />
                        </div>
                    )}
                    {row && <p>{liveText(row, options.data)}</p>}
                    <ErrorLine error={options.error ?? switching.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!chosen || blocked || switching.isPending}>
                            {switching.isPending
                                ? "Switching…"
                                : downloading
                                  ? "Download and switch"
                                  : "Switch base"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
