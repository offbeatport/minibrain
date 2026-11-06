import { useMutation } from "@tanstack/react-query";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Label,
} from "obp-ui";
import { useEffect, useState } from "react";
import type { ModelRow } from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { builtOn, isLiveRow, rowId } from "~/lib/teardown";
import { bytes } from "~/lib/time";
import type { Entry } from "./entries";

export type DeleteItem = {
    id: string;
    name: string;
    publisher: string | null;
    detail: string;
    live: boolean;
};

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function uniqueRows(rows: ModelRow[]): ModelRow[] {
    return [...new Map(rows.map((row) => [rowId(row), row])).values()];
}

function baseName(rows: ModelRow[], key: string | null | undefined): string {
    return rows.find((row) => row.kind === "base" && row.key === key)?.name ?? key ?? "its base";
}

export function rowItem(row: ModelRow, rows: ModelRow[], detail?: string): DeleteItem {
    const versions = row.versions?.length ?? 0;
    return {
        id: rowId(row),
        name: row.name,
        publisher: row.kind === "base" ? (row.publisher ?? null) : null,
        detail:
            detail ??
            (row.kind === "base"
                ? `Base model${row.size_bytes ? ` · ${bytes(row.size_bytes)}` : ""}`
                : `${versions ? `${plural(versions, "version")} · ` : ""}On ${baseName(rows, row.base_model)}`),
        live: isLiveRow(row),
    };
}

function entryItem(entry: Entry, rows: ModelRow[]): DeleteItem {
    const { model, version } = entry;
    if (!version) {
        return rowItem(model, rows);
    }
    return {
        id: entry.key,
        name: `${model.name} v${version.number}`,
        publisher: null,
        detail: "This version only; the model stays",
        live: version.live,
    };
}

export function DeleteList({ items }: { items: DeleteItem[] }) {
    return (
        <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-lg border">
            {items.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                    <PublisherLogo publisher={item.publisher} name={item.name} />
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{item.name}</span>
                        <span className="truncate text-sm text-muted-foreground">
                            {item.detail}
                        </span>
                    </span>
                    {item.live && <StatusText tone="warning">Live</StatusText>}
                </li>
            ))}
        </ul>
    );
}

export function DeleteModelsDialog({
    chosen,
    rows,
    onOpenChange,
    onDelete,
}: {
    chosen: Entry[] | null;
    rows: ModelRow[];
    onOpenChange: (open: boolean) => void;
    onDelete: (cascade: boolean) => Promise<unknown>;
}) {
    const [cascade, setCascade] = useState(false);
    const [undeploy, setUndeploy] = useState(false);
    useEffect(() => {
        if (chosen) {
            setCascade(false);
            setUndeploy(false);
        }
    }, [chosen]);
    const picked = chosen ?? [];
    const whole = new Set(
        picked.filter((entry) => !entry.version).map((entry) => rowId(entry.model)),
    );
    const bases = uniqueRows(
        picked
            .filter((entry) => !entry.version && entry.model.kind === "base")
            .map((entry) => entry.model),
    );
    const orphans = uniqueRows(bases.flatMap((base) => builtOn(rows, base))).filter(
        (row) => !whole.has(rowId(row)),
    );
    const owners = bases.filter((base) => orphans.some((row) => row.base_model === base.key));
    const items = picked.map((entry) => entryItem(entry, rows));
    const dependents = orphans.map((row) =>
        rowItem(row, rows, `Built on ${baseName(rows, row.base_model)}`),
    );
    const live = [...items, ...(cascade ? dependents : [])].filter((item) => item.live).length;
    const versions = picked.filter((entry) => entry.version).length;
    const models = picked.length - versions + (cascade ? orphans.length : 0);
    const freed = bases
        .filter((base) => base.availability.state === "available")
        .reduce((sum, base) => sum + (base.size_bytes ?? 0), 0);
    const parts = [
        models ? plural(models, "model") : "",
        versions ? plural(versions, "version") : "",
    ]
        .filter(Boolean)
        .join(" and ");
    const needsCascade = orphans.length > 0 && !cascade;
    const needsUndeploy = live > 0 && !undeploy;
    const start = useMutation({
        mutationFn: () => onDelete(cascade),
        onSuccess: () => onOpenChange(false),
    });
    return (
        <Dialog open={chosen !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{`Delete ${parts}?`}</DialogTitle>
                    <DialogDescription>
                        {models
                            ? "Models go with all their versions, data links, scores and API keys. "
                            : ""}
                        {versions ? "Versions go with their adapters, scores and results. " : ""}
                        Their jobs and request logs stay as history. This cannot be undone.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                    <DeleteList items={items} />
                    {freed > 0 && (
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {`Frees ${bytes(freed)} on disk.`}
                        </span>
                    )}
                </div>
                {orphans.length > 0 && (
                    <div className="flex flex-col gap-3 rounded-lg border p-3">
                        <Label className="flex items-start gap-2 font-normal">
                            <Checkbox
                                checked={cascade}
                                onCheckedChange={(value) => setCascade(value === true)}
                                className="mt-0.5"
                            />
                            <span className="flex flex-col gap-0.5">
                                <span className="font-medium">
                                    {`Also delete the ${plural(orphans.length, "model")} built on ${owners.map((base) => base.name).join(", ")}`}
                                </span>
                                <span className="text-sm text-muted-foreground">
                                    A base model can't go while models are built on it. Deselect it
                                    to keep them.
                                </span>
                            </span>
                        </Label>
                        <DeleteList items={dependents} />
                    </div>
                )}
                {live > 0 && (
                    <Label className="flex items-start gap-2 font-normal">
                        <Checkbox
                            checked={undeploy}
                            onCheckedChange={(value) => setUndeploy(value === true)}
                            className="mt-0.5"
                        />
                        <span className="flex flex-col gap-0.5">
                            <span className="font-medium">
                                {`Undeploy ${plural(live, "live model")} first`}
                            </span>
                            <span className="text-sm text-muted-foreground">
                                Apps calling {live === 1 ? "it" : "them"} get errors from then on.
                            </span>
                        </span>
                    </Label>
                )}
                <ErrorLine error={start.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={needsCascade || needsUndeploy || start.isPending}
                        onClick={() => start.mutate()}
                    >
                        {start.isPending
                            ? "Deleting…"
                            : `${live > 0 ? "Undeploy and delete" : "Delete"} ${parts}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
