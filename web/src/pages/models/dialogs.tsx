import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
} from "obp-ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { type ModelRow, api, succeed, unwrap } from "~/api/client";
import { keys, useBases, useCatalog, useModelSources } from "~/api/queries";
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

function splitTags(text: string): string[] {
    return text
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
}

function Field({
    id,
    label,
    children,
    hint,
}: { id: string; label: string; children: ReactNode; hint?: string }) {
    return (
        <div className="flex flex-col gap-1">
            <Label htmlFor={id}>{label}</Label>
            {children}
            {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
        </div>
    );
}

export function CreateModelDialog({
    open,
    onOpenChange,
    base,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    base?: string;
}) {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const bases = useBases();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [tags, setTags] = useState("");
    const [chosen, setChosen] = useState(base ?? "");
    useEffect(() => {
        if (open) {
            setChosen(base ?? "");
        }
    }, [open, base]);
    const create = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/minibrains", {
                    body: {
                        name: name.trim(),
                        description: description.trim(),
                        tags: splitTags(tags),
                        base_model: chosen || null,
                    },
                }),
            ),
        onSuccess: async (minibrain) => {
            await refresh();
            onOpenChange(false);
            router.history.push(`/data?minibrain=${encodeURIComponent(minibrain.slug)}`);
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (name.trim()) {
            create.mutate();
        }
    };
    const options = bases.data ?? [];
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <DialogHeader>
                        <DialogTitle>Create model</DialogTitle>
                        <DialogDescription>
                            A Classify model: text in, one label out. Next you add examples on the
                            Data page.
                        </DialogDescription>
                    </DialogHeader>
                    <Field id="create-name" label="Name">
                        <Input
                            id="create-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="IT ticket classifier"
                            autoFocus
                        />
                    </Field>
                    <Field id="create-description" label="Description">
                        <Textarea
                            id="create-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            rows={2}
                            placeholder="Routes incoming tickets to the right queue"
                        />
                    </Field>
                    <Field
                        id="create-base"
                        label="Base model"
                        hint="Only base models with a tested chat template can be trained."
                    >
                        <Select
                            value={chosen || options[0] || ""}
                            onValueChange={(value) => setChosen(String(value ?? ""))}
                        >
                            <SelectTrigger id="create-base" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {options.map((option) => (
                                    <SelectItem key={option} value={option}>
                                        {option}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field id="create-tags" label="Tags" hint="Comma separated.">
                        <Input
                            id="create-tags"
                            value={tags}
                            onChange={(event) => setTags(event.target.value)}
                        />
                    </Field>
                    <ErrorLine error={create.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || create.isPending}>
                            Create model
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ImportModelDialog({
    open,
    onOpenChange,
}: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const refresh = useModelsRefresh();
    const sources = useModelSources();
    const catalog = useCatalog();
    const [kind, setKind] = useState<"folder" | "s3">("folder");
    const [location, setLocation] = useState("");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [match, setMatch] = useState("detect");
    const s3 = sources.data?.find((source) => source.type === "s3");
    const variants = (catalog.data?.entries ?? []).flatMap((entry) =>
        entry.variants.map((variant) => ({
            id: variant.id,
            label: `${entry.name} · ${variant.label}`,
        })),
    );
    const start = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/models/import", {
                    body: {
                        name: name.trim(),
                        source_type: kind,
                        location: location.trim(),
                        description: description.trim(),
                        tags: [],
                        variant_id: match === "detect" ? null : match,
                    },
                }),
            ),
        onSuccess: async () => {
            await refresh();
            onOpenChange(false);
            setLocation("");
            setName("");
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (name.trim() && location.trim()) {
            start.mutate();
        }
    };
    const placeholder =
        kind === "folder"
            ? "/srv/models/qwen3-1.7b"
            : s3?.location
              ? "qwen3-1.7b"
              : "s3://bucket/models/qwen3-1.7b";
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <DialogHeader>
                        <DialogTitle>Import model</DialogTitle>
                        <DialogDescription>
                            Copies a Hugging Face format folder (config, tokenizer, safetensors)
                            into managed storage. Files stay on your infrastructure; nothing is sent
                            anywhere.
                        </DialogDescription>
                    </DialogHeader>
                    <Field id="import-kind" label="Source">
                        <Select
                            value={kind}
                            onValueChange={(value) => setKind(value === "s3" ? "s3" : "folder")}
                        >
                            <SelectTrigger id="import-kind" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="folder">
                                    Folder on the minibrain server
                                </SelectItem>
                                <SelectItem value="s3">S3-compatible bucket</SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field
                        id="import-location"
                        label={kind === "folder" ? "Folder path" : "Bucket path"}
                        hint={
                            kind === "folder"
                                ? "Works with `hf download <repo> --revision <sha> --local-dir <dir>`."
                                : s3?.location
                                  ? `Relative to ${s3.location}, or a full s3:// URL.`
                                  : "A full s3:// URL; credentials come from the server's AWS_* variables."
                        }
                    >
                        <Input
                            id="import-location"
                            value={location}
                            onChange={(event) => setLocation(event.target.value)}
                            placeholder={placeholder}
                            className="font-mono"
                        />
                    </Field>
                    <Field id="import-name" label="Name">
                        <Input
                            id="import-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </Field>
                    <Field id="import-description" label="Description">
                        <Input
                            id="import-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </Field>
                    <Field
                        id="import-match"
                        label="Catalogue match"
                        hint="A match is checked file by file against the catalogue checksums; anything else imports as not verified."
                    >
                        <Select
                            value={match}
                            onValueChange={(value) => setMatch(String(value ?? "detect"))}
                        >
                            <SelectTrigger id="import-match" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="detect">
                                    Detect from download metadata
                                </SelectItem>
                                {variants.map((variant) => (
                                    <SelectItem key={variant.id} value={variant.id}>
                                        {variant.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                    <ErrorLine error={start.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={!name.trim() || !location.trim() || start.isPending}
                        >
                            Import
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
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
            <DialogContent className="max-w-lg">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        save.mutate();
                    }}
                    className="flex flex-col gap-4"
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
    run: () => Promise<unknown>;
};

export function ConfirmAction({
    confirmation,
    onOpenChange,
}: {
    confirmation: Confirmation | null;
    onOpenChange: (open: boolean) => void;
}) {
    const action = useMutation({
        mutationFn: async () => confirmation?.run(),
        onSuccess: () => onOpenChange(false),
    });
    return (
        <Dialog open={confirmation !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{confirmation?.title}</DialogTitle>
                    <DialogDescription asChild>
                        <div className="flex flex-col gap-2">{confirmation?.description}</div>
                    </DialogDescription>
                </DialogHeader>
                <ErrorLine error={action.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant={confirmation?.destructive ? "destructive" : "default"}
                        onClick={() => action.mutate()}
                        disabled={action.isPending}
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
            <DialogContent className="max-w-lg">
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
