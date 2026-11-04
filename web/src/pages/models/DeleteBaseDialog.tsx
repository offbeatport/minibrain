import { useMutation } from "@tanstack/react-query";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Input,
    Label,
    RadioGroup,
    RadioGroupItem,
} from "obp-ui";
import { useEffect, useState } from "react";
import type { ModelRow } from "~/api/client";
import { ErrorLine } from "~/components/Section";
import { deleteModel, isLiveRow, removeFiles } from "~/lib/teardown";
import { bytes } from "~/lib/time";
import { DeleteList, rowItem } from "./DeleteModelsDialog";

type Choice = "files" | "cascade";

function count(total: number, one: string, many: string): string {
    return `${total} ${total === 1 ? one : many}`;
}

export function DeleteBaseDialog({
    row,
    dependents,
    onOpenChange,
    onStarted,
}: {
    row: ModelRow | null;
    dependents: ModelRow[];
    onOpenChange: (open: boolean) => void;
    onStarted: () => Promise<unknown>;
}) {
    const [choice, setChoice] = useState<Choice>("files");
    const [typed, setTyped] = useState("");
    useEffect(() => {
        if (row) {
            setChoice("files");
            setTyped("");
        }
    }, [row]);
    const live = dependents.filter(isLiveRow).length + (row && isLiveRow(row) ? 1 : 0);
    const busy = dependents.filter((item) => ["running", "queued"].includes(item.activity.state));
    const start = useMutation({
        mutationFn: async () => {
            if (!row) {
                return;
            }
            if (choice === "files") {
                await removeFiles(row);
            } else {
                await deleteModel(row, { cascade: true, undeploy: live > 0 });
            }
        },
        onSuccess: async () => {
            await onStarted();
            onOpenChange(false);
        },
    });
    const name = row?.name ?? "";
    const others = count(dependents.length, "model", "models");
    const confirmed = choice === "files" || typed.trim() === name;
    const blocked = choice === "cascade" && busy.length > 0;
    return (
        <Dialog open={row !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{`Delete ${name}?`}</DialogTitle>
                    <DialogDescription>
                        {`${others} ${dependents.length === 1 ? "is" : "are"} built on it.`}
                    </DialogDescription>
                </DialogHeader>
                <DeleteList
                    items={dependents.map((item) => rowItem(item, [], `Built on ${name}`))}
                />
                <RadioGroup
                    value={choice}
                    onValueChange={(next) => setChoice(next === "cascade" ? "cascade" : "files")}
                    className="flex flex-col gap-3"
                >
                    <Label className="flex items-start gap-2 font-normal">
                        <RadioGroupItem value="files" className="mt-0.5" />
                        <span className="flex flex-col">
                            <span>Remove its files</span>
                            <span className="text-sm text-muted-foreground">
                                {row?.size_bytes ? `Frees ${bytes(row.size_bytes)} on disk. ` : ""}
                                {`${name} and the ${others} built on it stay; they show Base missing files until it is downloaded again.`}
                            </span>
                        </span>
                    </Label>
                    <Label className="flex items-start gap-2 font-normal">
                        <RadioGroupItem value="cascade" className="mt-0.5" />
                        <span className="flex flex-col">
                            <span>{`Delete it and the ${others} built on it`}</span>
                            <span className="text-sm text-muted-foreground">
                                Their trained versions, adapters, snapshots only they use,
                                deployments and API key scopes go too. This cannot be undone.
                            </span>
                        </span>
                    </Label>
                </RadioGroup>
                {choice === "cascade" && (
                    <div className="flex flex-col gap-field">
                        {live > 0 && (
                            <p className="text-sm text-warning">
                                {`${live} ${live === 1 ? "is" : "are"} live and will stop serving.`}
                            </p>
                        )}
                        {busy.length > 0 && (
                            <p className="text-sm text-destructive">
                                {`${busy.map((item) => item.name).join(", ")} ${busy.length === 1 ? "has" : "have"} a job running; cancel it first.`}
                            </p>
                        )}
                        <Field id="confirm-base-name" label={`Type ${name} to confirm`}>
                            <Input
                                id="confirm-base-name"
                                value={typed}
                                autoComplete="off"
                                onChange={(event) => setTyped(event.target.value)}
                            />
                        </Field>
                    </div>
                )}
                <ErrorLine error={start.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={!confirmed || blocked || start.isPending}
                        onClick={() => start.mutate()}
                    >
                        {choice === "files"
                            ? "Remove files"
                            : `Delete ${count(dependents.length + 1, "model", "models")}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
