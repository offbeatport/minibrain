import { GitCompare, PowerOff, Trash2, X } from "lucide-react";
import {
    Badge,
    Button,
    type CompareRow,
    CompareTable,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    InfoTip,
    Separator,
} from "obp-ui";
import type { ModelRow, ModelVersionRow } from "~/api/client";
import type { Abilities } from "~/lib/access";
import { costSortValue, costText } from "~/lib/cost";
import { relativeTime } from "~/lib/time";
import type { Entry } from "../entries";
import { Tip } from "./cells";
import {
    type ListModel,
    canMakeLive,
    isDeployed,
    pct,
    plural,
    variantKey,
    versionKey,
    versionName,
    versionState,
} from "./model";
import type { Handlers } from "./rows";

export type PickedVersion = { model: ListModel; version: ModelVersionRow };
export type PickedVariant = { model: ListModel; row: ModelRow };

export function pickedVersions(models: ListModel[], keys: string[]): PickedVersion[] {
    return models.flatMap((model) =>
        model.versions
            .filter((version) => keys.includes(versionKey(model.key, version.number)))
            .map((version) => ({ model, version })),
    );
}

export function pickedVariants(models: ListModel[], keys: string[]): PickedVariant[] {
    return models.flatMap((model) =>
        model.variants
            .filter((row) => keys.includes(variantKey(row)))
            .map((row) => ({ model, row })),
    );
}

function compareBlock(picked: PickedVersion[]): string | null {
    if (picked.length !== 2) {
        return `Compare takes exactly two versions of one model; ${plural(picked.length, "version")} ${picked.length === 1 ? "is" : "are"} ticked.`;
    }
    if (picked[0].model.key !== picked[1].model.key) {
        return "The two versions belong to different models; pick two of one model.";
    }
    return null;
}

function selectionText(versions: PickedVersion[], variants: PickedVariant[]): string {
    const parts = [
        versions.length > 0 && plural(versions.length, "version"),
        variants.length > 0 && plural(variants.length, "variant"),
    ].filter(Boolean);
    const owners = [...new Set([...versions, ...variants].map((item) => item.model.name))];
    return `${parts.join(" and ")} selected${owners.length === 1 ? ` of ${owners[0]}` : ""}`;
}

export function deletable(versions: PickedVersion[], variants: PickedVariant[]): Entry[] {
    return [
        ...versions
            .filter((item) => !item.version.live && item.version.status !== "deleting")
            .map((item) => ({
                key: `custom:${item.model.key}@${item.version.number}`,
                model: item.model.row,
                version: item.version,
            })),
        ...variants
            .filter((item) => !isDeployed(item.row))
            .map((item) => ({ key: `base:${item.row.key}`, model: item.row, version: null })),
    ];
}

export function SelectionBar({
    versions,
    variants,
    on,
    can,
    onClear,
}: {
    versions: PickedVersion[];
    variants: PickedVariant[];
    on: Handlers;
    can: Abilities;
    onClear: () => void;
}) {
    const mixed = versions.length > 0 && variants.length > 0;
    const live = [
        ...versions
            .filter((item) => item.version.live)
            .map((item) => `v${item.version.number} of ${item.model.name}`),
        ...variants
            .filter((item) => isDeployed(item.row))
            .map((item) => `${item.model.name} ${item.row.variant_label ?? item.row.key}`),
    ];
    const going = deletable(versions, variants);
    const blocked = compareBlock(versions);
    const sorted = [...versions].sort((a, b) => a.version.number - b.version.number);
    const liveVariants = variants.filter((item) => isDeployed(item.row));
    const idleVariants = variants.filter(
        (item) => !isDeployed(item.row) && item.row.availability.state === "available",
    );
    const canDelete = can.admin || variants.length === 0;
    return (
        <div className="flex min-h-8 flex-wrap items-center gap-2">
            <span className="font-medium tabular-nums">{selectionText(versions, variants)}</span>
            <Button variant="outline" onClick={onClear}>
                <X aria-hidden="true" />
                Clear selection
            </Button>
            {can.build && live.length > 0 && (
                <span className="text-sm text-muted-foreground">
                    {`${live.join(", ")} ${live.length === 1 ? "is" : "are"} live and will not be deleted.`}
                </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
                {mixed && (
                    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        Only Delete fits both
                        <InfoTip label="Why only Delete">
                            Compare works on two versions of one custom model; Deploy and Undeploy
                            work on base variants. Tick only versions or only variants to see those.
                        </InfoTip>
                    </span>
                )}
                {!mixed && versions.length > 0 && (
                    <Tip tip={blocked}>
                        <Button
                            variant="outline"
                            disabled={Boolean(blocked)}
                            onClick={() =>
                                on.compare(sorted[0].model, [
                                    sorted[0].version.number,
                                    sorted[1].version.number,
                                ])
                            }
                        >
                            <GitCompare aria-hidden="true" />
                            Compare
                        </Button>
                    </Tip>
                )}
                {can.build && !mixed && variants.length > 0 && (
                    <>
                        <Tip
                            tip={
                                idleVariants.length === 0
                                    ? "None of them can be deployed now."
                                    : null
                            }
                        >
                            <Button
                                variant="outline"
                                disabled={idleVariants.length === 0}
                                onClick={() => on.deploy(idleVariants.map((item) => item.row))}
                            >
                                Deploy
                            </Button>
                        </Tip>
                        <Tip tip={liveVariants.length === 0 ? "None of them is deployed." : null}>
                            <Button
                                variant="outline"
                                disabled={liveVariants.length === 0}
                                onClick={() => on.undeploy(liveVariants.map((item) => item.row))}
                            >
                                <PowerOff aria-hidden="true" />
                                Undeploy
                            </Button>
                        </Tip>
                    </>
                )}
                {can.build && canDelete && (
                    <>
                        <Separator
                            orientation="vertical"
                            className="mx-1 data-[orientation=vertical]:h-5"
                        />
                        <Tip tip={going.length === 0 ? "Everything ticked is live." : null}>
                            <Button
                                variant="destructive"
                                disabled={going.length === 0}
                                onClick={() => on.remove(going)}
                            >
                                <Trash2 aria-hidden="true" />
                                {variants.length > 0 && versions.length === 0
                                    ? "Delete files"
                                    : "Delete"}
                            </Button>
                        </Tip>
                    </>
                )}
            </div>
        </div>
    );
}

type Compared = { model: ListModel; numbers: [number, number] };

function numeric(
    id: string,
    label: string,
    values: (number | null | undefined)[],
    show: (value: number) => string,
    better: "higher" | "lower",
    delta: (amount: number) => string,
): CompareRow {
    return {
        id,
        label,
        cells: values.map((value, index) => (
            <span key={`${id}-${index === 0 ? "a" : "b"}`} className="tabular-nums">
                {value === null || value === undefined ? "–" : show(value)}
            </span>
        )),
        values,
        differs: values[0] !== values[1],
        formatDelta: delta,
        better,
    };
}

function textRow(id: string, label: string, values: string[]): CompareRow {
    return {
        id,
        label,
        cells: values.map((value, index) => (
            <span key={`${id}-${index === 0 ? "a" : "b"}`} className="tabular-nums">
                {value}
            </span>
        )),
        values,
        differs: values[0] !== values[1],
    };
}

function rowsOf(pair: ModelVersionRow[]): CompareRow[] {
    const ms = (value: number) => `${Math.round(value)} ms`;
    return [
        numeric(
            "score",
            "Held-out score",
            pair.map((version) => version.score),
            pct,
            "higher",
            (amount) => `${(amount * 100).toFixed(1)} pts`,
        ),
        textRow(
            "rule",
            "Promotion rule",
            pair.map((version) =>
                version.promotion ? (version.promotion.passed ? "Passes" : "Below rule") : "–",
            ),
        ),
        numeric(
            "p50",
            "Latency p50",
            pair.map((version) => version.latency_p50_ms),
            ms,
            "lower",
            ms,
        ),
        numeric(
            "p95",
            "Latency p95",
            pair.map((version) => version.latency_p95_ms),
            ms,
            "lower",
            ms,
        ),
        {
            id: "cost",
            label: "Cost / 1k req.",
            cells: pair.map((version, index) => (
                <span key={`cost-${index === 0 ? "a" : "b"}`} className="tabular-nums">
                    {costText(version.cost)}
                </span>
            )),
            values: pair.map((version) => (version.cost ? costSortValue(version.cost) : null)),
            differs: costText(pair[0].cost) !== costText(pair[1].cost),
        },
        textRow(
            "kind",
            "Kind",
            pair.map((version) => (version.kind === "lora" ? "Fine-tuned" : "Prompt only")),
        ),
        textRow(
            "status",
            "Status",
            pair.map((version) => versionState(version).label),
        ),
        textRow(
            "created",
            "Created",
            pair.map((version) => relativeTime(version.created_at)),
        ),
    ];
}

export function CompareDialog({
    compared,
    on,
    can,
    onClose,
}: {
    compared: Compared | null;
    on: Handlers;
    can: Abilities;
    onClose: () => void;
}) {
    const model = compared?.model;
    const pair = (compared?.numbers ?? [])
        .map((number) => model?.versions.find((version) => version.number === number))
        .filter((version): version is ModelVersionRow => version !== undefined);
    const better = [...pair].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
    return (
        <Dialog open={compared !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {pair.length === 2
                            ? `${model?.name}: v${pair[0].number} and v${pair[1].number}`
                            : "Compare versions"}
                    </DialogTitle>
                    <DialogDescription>
                        Scores are on the model's held-out rows; latency and cost are measured when
                        each version was scored.
                    </DialogDescription>
                </DialogHeader>
                {model && pair.length === 2 && (
                    <CompareTable
                        label={`Compare v${pair[0].number} and v${pair[1].number} of ${model.name}`}
                        baseline={String(pair[0].number)}
                        columns={pair.map((version) => ({
                            id: String(version.number),
                            label: versionName(version),
                            header: (
                                <span className="flex items-center gap-2">
                                    <span className="tabular-nums">{versionName(version)}</span>
                                    {version.live && <Badge variant="success">live</Badge>}
                                </span>
                            ),
                        }))}
                        sections={[{ id: "facts", rows: rowsOf(pair) }]}
                    />
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Close
                    </Button>
                    {model && better && can.build && canMakeLive(model, better) && (
                        <Button
                            onClick={() => {
                                onClose();
                                on.makeLive(model, better);
                            }}
                        >
                            {`Make v${better.number} live`}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
