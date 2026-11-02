import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Check, Cloud, FolderOpen, GraduationCap, type LucideIcon } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    ProviderLogo,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    cn,
} from "obp-ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { api, unwrap } from "~/api/client";
import { useBases, useCatalog, useModelSources } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { Field, splitTags, useModelsRefresh } from "./dialogs";

export type AddSource = "custom" | "huggingface" | "folder" | "s3";

type SourceOption = {
    key: AddSource;
    label: string;
    hint: string;
    icon: (selected: boolean) => ReactNode;
};

function lucide(Icon: LucideIcon) {
    return (selected: boolean) => (
        <Icon
            aria-hidden="true"
            className={cn("size-6", selected ? "text-primary" : "text-muted-foreground")}
        />
    );
}

const SOURCES: SourceOption[] = [
    {
        key: "custom",
        label: "Custom model",
        hint: "Train a base model on your data",
        icon: lucide(GraduationCap),
    },
    {
        key: "huggingface",
        label: "Hugging Face",
        hint: "Download from the catalogue",
        icon: () => <ProviderLogo id="huggingface" className="size-6" />,
    },
    {
        key: "folder",
        label: "Folder",
        hint: "Import files on the server",
        icon: lucide(FolderOpen),
    },
    {
        key: "s3",
        label: "S3 bucket",
        hint: "Import from object storage",
        icon: lucide(Cloud),
    },
];

function SourceCards({
    value,
    onChange,
}: {
    value: AddSource;
    onChange: (source: AddSource) => void;
}) {
    return (
        <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <legend className="sr-only">What to add</legend>
            {SOURCES.map((option) => {
                const selected = option.key === value;
                return (
                    <label
                        key={option.key}
                        className={cn(
                            "relative flex cursor-pointer flex-col items-start gap-2 rounded-lg border p-3 has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background",
                            selected
                                ? "border-primary bg-accent text-accent-foreground"
                                : "bg-background hover:bg-secondary",
                        )}
                    >
                        <input
                            type="radio"
                            name="add-source"
                            value={option.key}
                            checked={selected}
                            onChange={() => onChange(option.key)}
                            className="sr-only"
                        />
                        {option.icon(selected)}
                        <span className="flex flex-col">
                            <span className="font-semibold">{option.label}</span>
                            <span className="text-sm text-muted-foreground">{option.hint}</span>
                        </span>
                        {selected && (
                            <Check
                                aria-hidden="true"
                                className="absolute top-2.5 right-2.5 size-4 text-primary"
                            />
                        )}
                    </label>
                );
            })}
        </fieldset>
    );
}

function Footer({
    onCancel,
    submit,
    disabled,
}: {
    onCancel: () => void;
    submit: string;
    disabled: boolean;
}) {
    return (
        <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
            </Button>
            <Button type="submit" disabled={disabled}>
                {submit}
            </Button>
        </DialogFooter>
    );
}

function CustomForm({ base, onClose }: { base?: string; onClose: () => void }) {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const bases = useBases();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [tags, setTags] = useState("");
    const [chosen, setChosen] = useState(base ?? "");
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
            onClose();
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
        <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
                A Classify model: text in, one label out. Next you add examples on the Data page.
            </p>
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
            <Footer
                onCancel={onClose}
                submit="Add model"
                disabled={!name.trim() || create.isPending}
            />
        </form>
    );
}

function HubForm({ onClose }: { onClose: () => void }) {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const catalog = useCatalog();
    const [repo, setRepo] = useState("");
    const add = useMutation({
        mutationFn: () => unwrap(api.POST("/api/catalog/hub", { body: { repo: repo.trim() } })),
        onSuccess: async (entry) => {
            await refresh();
            onClose();
            router.history.push(`/discover/${encodeURIComponent(entry.id)}`);
        },
    });
    const browse = () => {
        onClose();
        router.history.push("/discover");
    };
    const data = catalog.data;
    if (data && !data.downloads_allowed) {
        return (
            <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                    The Model sources policy allows imported files only. Download the files
                    elsewhere, then import them from a folder or an S3 bucket.
                </p>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Close
                    </Button>
                </DialogFooter>
            </div>
        );
    }
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (repo.trim()) {
            add.mutate();
        }
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
                Discover lists the models we support, with hardware fit, licence and access checks
                before you download.
            </p>
            <div>
                <Button type="button" onClick={browse}>
                    Browse the catalogue
                </Button>
            </div>
            {data?.hub_add_allowed && (
                <>
                    <Field
                        id="hub-repo"
                        label="Or paste a Hugging Face link or id"
                        hint="minibrain reads that one model's details and adds it to Discover, badged untested unless our engines support its architecture."
                    >
                        <Input
                            id="hub-repo"
                            value={repo}
                            onChange={(event) => setRepo(event.target.value)}
                            placeholder="Qwen/Qwen3-8B"
                            className="font-mono"
                        />
                    </Field>
                    <ErrorLine error={add.error} />
                    <Footer
                        onCancel={onClose}
                        submit={add.isPending ? "Checking…" : "Add to Discover"}
                        disabled={!repo.trim() || add.isPending}
                    />
                </>
            )}
        </form>
    );
}

function ImportForm({ kind, onClose }: { kind: "folder" | "s3"; onClose: () => void }) {
    const refresh = useModelsRefresh();
    const sources = useModelSources();
    const catalog = useCatalog();
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
            onClose();
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
        <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
                Copies a Hugging Face format folder (config, tokenizer, safetensors) into managed
                storage. Files stay on your infrastructure; nothing is sent anywhere.
            </p>
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
                    autoFocus
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
                        <SelectItem value="detect">Detect from download metadata</SelectItem>
                        {variants.map((variant) => (
                            <SelectItem key={variant.id} value={variant.id}>
                                {variant.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
            <ErrorLine error={start.error} />
            <Footer
                onCancel={onClose}
                submit="Import"
                disabled={!name.trim() || !location.trim() || start.isPending}
            />
        </form>
    );
}

export function AddModelDialog({
    open,
    onOpenChange,
    source = "custom",
    base,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    source?: AddSource;
    base?: string;
}) {
    const [chosen, setChosen] = useState<{ for: AddSource; value: AddSource } | null>(null);
    const current = chosen && chosen.for === source ? chosen.value : source;
    const close = () => {
        setChosen(null);
        onOpenChange(false);
    };
    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Add model</DialogTitle>
                    <DialogDescription>Choose what to add.</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-5">
                    <SourceCards
                        value={current}
                        onChange={(value) => setChosen({ for: source, value })}
                    />
                    {current === "custom" && (
                        <CustomForm key={`custom-${base}`} base={base} onClose={close} />
                    )}
                    {current === "huggingface" && <HubForm onClose={close} />}
                    {(current === "folder" || current === "s3") && (
                        <ImportForm key={current} kind={current} onClose={close} />
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
