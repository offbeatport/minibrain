import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    InfoTip,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    useToast,
} from "obp-ui";
import { type FormEvent, useEffect, useState } from "react";
import { useDeletePreset, usePresets, useSavePreset } from "~/api/playgroundQueries";
import { ErrorLine } from "~/components/Section";
import { type SavedPreset, type Settings, settingsOf } from "~/lib/playground";

const NO_PRESET = "none";

type Naming = { mode: "create" | "rename"; name: string; isDefault: boolean } | null;

function NameDialog({
    naming,
    onClose,
    onSubmit,
    busy,
    error,
}: {
    naming: Naming;
    onClose: () => void;
    onSubmit: (name: string, isDefault: boolean) => void;
    busy: boolean;
    error: unknown;
}) {
    const [name, setName] = useState("");
    const [isDefault, setDefault] = useState(false);
    useEffect(() => {
        setName(naming?.name ?? "");
        setDefault(naming?.isDefault ?? false);
    }, [naming]);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (name.trim()) {
            onSubmit(name.trim(), isDefault);
        }
    };
    return (
        <Dialog open={naming !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={submit} className="flex flex-col gap-6">
                    <DialogHeader>
                        <DialogTitle>
                            {naming?.mode === "rename" ? "Rename preset" : "Save as a preset"}
                        </DialogTitle>
                        <DialogDescription>
                            A preset keeps every setting below the model, for you alone.
                        </DialogDescription>
                    </DialogHeader>
                    <Field id="preset-name" label="Name">
                        <Input
                            id="preset-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            autoFocus
                        />
                    </Field>
                    {naming?.mode === "create" && (
                        <div className="flex items-center justify-between gap-3">
                            <Label htmlFor="preset-default">
                                Load it when the Playground opens
                            </Label>
                            <Switch
                                id="preset-default"
                                checked={isDefault}
                                onCheckedChange={setDefault}
                            />
                        </div>
                    )}
                    <ErrorLine error={error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || !name.trim()}>
                            {naming?.mode === "rename" ? "Rename" : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function Presets({
    settings,
    onLoad,
    chosen,
    onChosen: setChosen,
}: {
    settings: Settings;
    onLoad: (next: Settings) => void;
    chosen: number | null;
    onChosen: (id: number | null) => void;
}) {
    const toast = useToast();
    const presets = usePresets();
    const save = useSavePreset();
    const remove = useDeletePreset();
    const [naming, setNaming] = useState<Naming>(null);
    const items: SavedPreset[] = presets.data ?? [];
    const current = items.find((item) => item.id === chosen) ?? null;
    const pick = (value: string) => {
        if (value === NO_PRESET) {
            setChosen(null);
            return;
        }
        const found = items.find((item) => String(item.id) === value);
        if (found) {
            setChosen(found.id);
            onLoad(settingsOf(found.settings));
        }
    };
    const stored = settings as unknown as Record<string, unknown>;
    const named = (name: string, isDefault: boolean) => {
        const body =
            naming?.mode === "rename" && current
                ? { id: current.id, name }
                : { name, settings: stored, is_default: isDefault };
        save.mutate(body, {
            onSuccess: (saved) => {
                setChosen(saved.id);
                setNaming(null);
                toast({
                    title: naming?.mode === "rename" ? "Preset renamed" : "Preset saved",
                    tone: "success",
                });
            },
        });
    };
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-label">
                <div className="flex items-center gap-1.5">
                    <Label htmlFor="playground-preset">Preset</Label>
                    <InfoTip label="About presets">
                        Saved, named sets of the settings below, kept for you on this install. The
                        default one loads when the Playground opens.
                    </InfoTip>
                </div>
                <Select
                    value={current ? String(current.id) : NO_PRESET}
                    onValueChange={(next) => pick(String(next ?? NO_PRESET))}
                >
                    <SelectTrigger id="playground-preset" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={NO_PRESET}>No preset</SelectItem>
                        {items.map((item) => (
                            <SelectItem
                                key={item.id}
                                value={String(item.id)}
                                description={item.is_default ? "Loads by default" : undefined}
                            >
                                {item.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="flex flex-wrap gap-2">
                <Button
                    size="sm"
                    variant="outline"
                    disabled={!current || save.isPending}
                    onClick={() =>
                        current &&
                        save.mutate(
                            { id: current.id, settings: stored },
                            {
                                onSuccess: () =>
                                    toast({ title: `Saved ${current.name}`, tone: "success" }),
                            },
                        )
                    }
                >
                    Save
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setNaming({ mode: "create", name: "", isDefault: false })}
                >
                    Save as
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    disabled={!current}
                    onClick={() =>
                        current &&
                        setNaming({
                            mode: "rename",
                            name: current.name,
                            isDefault: current.is_default,
                        })
                    }
                >
                    Rename
                </Button>
                <ConfirmDialog
                    trigger={
                        <Button size="sm" variant="outline" disabled={!current}>
                            Delete
                        </Button>
                    }
                    title={`Delete ${current?.name ?? "this preset"}?`}
                    description="The settings stay as they are on screen; only the saved preset goes."
                    confirmLabel="Delete"
                    destructive
                    onConfirm={() =>
                        current &&
                        remove.mutateAsync(current.id).then(() => {
                            setChosen(null);
                            toast({ title: "Preset deleted", tone: "success" });
                        })
                    }
                />
            </div>
            {current && (
                <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="playground-preset-default">Load by default</Label>
                    <Switch
                        id="playground-preset-default"
                        checked={current.is_default}
                        readOnly={save.isPending}
                        onCheckedChange={(checked) =>
                            save.mutate({ id: current.id, is_default: checked })
                        }
                    />
                </div>
            )}
            <ErrorLine error={presets.error ?? (naming ? null : save.error) ?? remove.error} />
            <NameDialog
                naming={naming}
                onClose={() => setNaming(null)}
                onSubmit={named}
                busy={save.isPending}
                error={naming ? save.error : null}
            />
        </div>
    );
}
