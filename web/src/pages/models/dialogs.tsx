import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Input,
    Label,
    Textarea,
} from "obp-ui";
import { type ReactNode, useEffect, useState } from "react";
import { type ModelRow, api, succeed, unwrap } from "~/api/client";
import { keys } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { bytes } from "~/lib/time";

export function useModelsRefresh() {
    const queryClient = useQueryClient();
    return () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: keys.models }),
            queryClient.invalidateQueries({ queryKey: keys.catalog }),
            queryClient.invalidateQueries({ queryKey: keys.minibrains }),
            queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        ]);
}

export function splitTags(text: string): string[] {
    return text
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
}

export function EditModelDialog({
    row,
    onOpenChange,
}: {
    row: ModelRow | null;
    onOpenChange: (open: boolean) => void;
}) {
    const refresh = useModelsRefresh();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [tags, setTags] = useState("");
    useEffect(() => {
        if (row) {
            setName(row.name);
            setDescription(row.description);
            setTags(row.tags.join(", "));
        }
    }, [row]);
    const save = useMutation({
        mutationFn: async () => {
            if (!row) {
                return;
            }
            const body = {
                name: name.trim(),
                description: description.trim(),
                tags: splitTags(tags),
            };
            if (row.kind === "base") {
                await unwrap(
                    api.PATCH("/api/models/base/{key}", {
                        params: { path: { key: row.key } },
                        body,
                    }),
                );
            } else {
                await unwrap(
                    api.PATCH("/api/minibrains/{slug}", {
                        params: { path: { slug: row.key } },
                        body,
                    }),
                );
            }
        },
        onSuccess: async () => {
            await refresh();
            onOpenChange(false);
        },
    });
    return (
        <Dialog open={row !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        save.mutate();
                    }}
                    className="contents"
                >
                    <DialogHeader>
                        <DialogTitle>Edit {row?.name}</DialogTitle>
                        <DialogDescription>
                            Name, description and tags only; files and versions stay as they are.
                        </DialogDescription>
                    </DialogHeader>
                    <Field id="edit-name" label="Name">
                        <Input
                            id="edit-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </Field>
                    <Field id="edit-description" label="Description">
                        <Textarea
                            id="edit-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            rows={2}
                        />
                    </Field>
                    <Field id="edit-tags" label="Tags" hint="Comma separated.">
                        <Input
                            id="edit-tags"
                            value={tags}
                            onChange={(event) => setTags(event.target.value)}
                        />
                    </Field>
                    <ErrorLine error={save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || save.isPending}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export type Confirmation = {
    title: string;
    description: ReactNode;
    confirmLabel: string;
    destructive?: boolean;
    acknowledge?: string;
    run: () => Promise<unknown>;
};

export function ConfirmAction({
    confirmation,
    onOpenChange,
}: {
    confirmation: Confirmation | null;
    onOpenChange: (open: boolean) => void;
}) {
    const [acknowledgedFor, setAcknowledgedFor] = useState<Confirmation | null>(null);
    const acknowledged = acknowledgedFor !== null && acknowledgedFor === confirmation;
    const action = useMutation({
        mutationFn: async () => confirmation?.run(),
        onSuccess: () => onOpenChange(false),
    });
    const blocked = Boolean(confirmation?.acknowledge) && !acknowledged;
    return (
        <Dialog open={confirmation !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{confirmation?.title}</DialogTitle>
                    <DialogDescription asChild>
                        <div className="flex flex-col gap-2">{confirmation?.description}</div>
                    </DialogDescription>
                </DialogHeader>
                {confirmation?.acknowledge && (
                    <Label className="flex items-center gap-2 font-normal">
                        <Checkbox
                            checked={acknowledged}
                            onCheckedChange={(value) =>
                                setAcknowledgedFor(value === true ? confirmation : null)
                            }
                        />
                        {confirmation.acknowledge}
                    </Label>
                )}
                <ErrorLine error={action.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant={confirmation?.destructive ? "destructive" : "default"}
                        onClick={() => action.mutate()}
                        disabled={blocked || action.isPending}
                    >
                        {confirmation?.confirmLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function TestBaseDialog({
    row,
    onOpenChange,
}: { row: ModelRow | null; onOpenChange: (open: boolean) => void }) {
    const [text, setText] = useState("Say hello in one short sentence.");
    const test = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/models/base/{key}/test", {
                    params: { path: { key: row?.key ?? "" } },
                    body: { text, max_tokens: 128 },
                }),
            ),
    });
    useEffect(() => {
        if (row === null) {
            test.reset();
        }
    }, [row, test.reset]);
    return (
        <Dialog open={row !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Test {row?.name}</DialogTitle>
                    <DialogDescription>
                        If {row?.name} is not loaded, minibrain starts a runtime for it on this
                        machine
                        {row?.needed_bytes
                            ? `, using about ${bytes(row.needed_bytes)} of memory`
                            : ""}
                        . It unloads after 15 minutes without requests. Nothing is deployed.
                    </DialogDescription>
                </DialogHeader>
                <Textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    rows={3}
                    aria-label="Prompt"
                />
                {test.data && (
                    <div className="flex flex-col gap-1 rounded-md border bg-secondary p-3">
                        <p className="whitespace-pre-wrap text-sm">{test.data.output}</p>
                        <p className="text-sm tabular-nums text-muted-foreground">
                            {Math.round(test.data.latency_ms)} ms · {test.data.completion_tokens}{" "}
                            tokens
                        </p>
                    </div>
                )}
                <ErrorLine error={test.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                    <Button onClick={() => test.mutate()} disabled={!text.trim() || test.isPending}>
                        {test.isPending ? "Running…" : "Run"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export async function cancelJob(jobId: number): Promise<void> {
    await succeed(api.POST("/api/jobs/{job_id}/cancel", { params: { path: { job_id: jobId } } }));
}
