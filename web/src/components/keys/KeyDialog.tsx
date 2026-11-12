import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Save } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldGroup,
    Input,
    Label,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useEffect, useState } from "react";
import { type KeyCreated, type KeyInfo, type ModelRef, api, unwrap } from "~/api/client";
import { keys, useKeys } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { useCan } from "~/lib/access";
import { AllModelsLabel, type Choice, ModelPicker, idOf, refOf, useChoices } from "./scope";

export type KeyEditing = { mode: "create"; models: ModelRef[] } | { mode: "edit"; key: KeyInfo };

type Scope = "models" | "all";

const DEFAULT_EXPIRY = "default";
const EXPIRY_OPTIONS = [
    { value: DEFAULT_EXPIRY, label: "Install default" },
    { value: "30", label: "30 days" },
    { value: "90", label: "90 days" },
    { value: "180", label: "180 days" },
    { value: "365", label: "1 year" },
];

export function useRefreshKeys() {
    const client = useQueryClient();
    return () =>
        Promise.all([
            client.invalidateQueries({ queryKey: keys.apiKeys }),
            client.invalidateQueries({ queryKey: keys.allModels }),
        ]);
}

function nameProblem(
    name: string,
    scope: Scope,
    picked: Set<string>,
    existing: KeyInfo[],
    choices: Choice[],
): string | null {
    const wanted = name.trim().toLowerCase();
    if (!wanted) {
        return "Name the key, so you can tell its calls apart in the logs.";
    }
    const named = existing.filter((key) => key.name.trim().toLowerCase() === wanted);
    const everything = named.find((key) => key.all_models);
    if (everything) {
        return `A key called ${everything.name} already calls every model.`;
    }
    if (scope === "all" && named.length > 0) {
        return `A key called ${named[0]?.name} already exists.`;
    }
    for (const key of named) {
        const model = key.models.find((item) => picked.has(idOf(item)));
        if (model) {
            const label = choices.find((choice) => idOf(choice) === idOf(model))?.name;
            return `A key called ${key.name} already calls ${label ?? model.name}.`;
        }
    }
    return null;
}

function ScopeChoice({ value, onChange }: { value: Scope; onChange: (scope: Scope) => void }) {
    return (
        <RadioGroup
            value={value}
            onValueChange={(next) => onChange(next === "all" ? "all" : "models")}
            className="flex flex-col gap-3"
            aria-label="Scope"
        >
            <Label className="flex items-start gap-2 font-normal">
                <RadioGroupItem value="models" className="mt-0.5" />
                <span className="flex flex-col">
                    <span>Specific models</span>
                    <span className="text-sm text-muted-foreground">
                        Only the models you pick below.
                    </span>
                </span>
            </Label>
            <Label className="flex items-start gap-2 font-normal">
                <RadioGroupItem value="all" className="mt-0.5" />
                <span className="flex flex-col">
                    <AllModelsLabel />
                    <span className="text-sm text-muted-foreground">
                        Every model on this install, including models added later. Admins only.
                    </span>
                </span>
            </Label>
        </RadioGroup>
    );
}

function ExpirySelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    return (
        <Select value={value} onValueChange={(next) => onChange(String(next ?? DEFAULT_EXPIRY))}>
            <SelectTrigger id="key-expiry" className="w-56">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

export function KeyDialog({
    editing,
    onOpenChange,
    onCreated,
}: {
    editing: KeyEditing | null;
    onOpenChange: (open: boolean) => void;
    onCreated: (key: KeyCreated) => void;
}) {
    const can = useCan();
    const refresh = useRefreshKeys();
    const choices = useChoices();
    const existing = useKeys();
    const [touched, setTouched] = useState(false);
    const [name, setName] = useState("");
    const [scope, setScope] = useState<Scope>("models");
    const [expiry, setExpiry] = useState(DEFAULT_EXPIRY);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    useEffect(() => {
        if (editing?.mode === "edit") {
            setName(editing.key.name);
            setScope(editing.key.all_models ? "all" : "models");
            setPicked(new Set(editing.key.models.map(idOf)));
        } else if (editing) {
            setName("");
            setTouched(false);
            setScope("models");
            setExpiry(DEFAULT_EXPIRY);
            setPicked(new Set(editing.models.map(idOf)));
        }
    }, [editing]);
    const save = useMutation({
        mutationFn: async () => {
            const everything = scope === "all";
            const scoped = {
                all_models: everything,
                models: everything ? [] : [...picked].map(refOf),
            };
            if (editing?.mode === "edit") {
                await unwrap(
                    api.PUT("/api/keys/{key_id}/models", {
                        params: { path: { key_id: editing.key.id } },
                        body: scoped,
                    }),
                );
                return;
            }
            const days = expiry === DEFAULT_EXPIRY ? null : Number(expiry);
            onCreated(
                await unwrap(
                    api.POST("/api/keys", {
                        body: { name: name.trim(), expires_in_days: days, ...scoped },
                    }),
                ),
            );
        },
        onSuccess: async () => {
            await refresh();
            onOpenChange(false);
        },
    });
    const toggle = (id: string, on: boolean) =>
        setPicked((current) => {
            const next = new Set(current);
            if (on) {
                next.add(id);
            } else {
                next.delete(id);
            }
            return next;
        });
    const creating = editing?.mode !== "edit";
    const others = (existing.data ?? []).filter(
        (key) => editing?.mode !== "edit" || key.id !== editing.key.id,
    );
    const problem = creating ? nameProblem(name, scope, picked, others, choices) : null;
    const empty = scope === "models" && picked.size === 0;
    const showScope = can.admin;
    return (
        <Dialog open={editing !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        setTouched(true);
                        if (!problem && !empty) {
                            save.mutate();
                        }
                    }}
                    noValidate
                    className="contents"
                >
                    <DialogHeader>
                        <DialogTitle>
                            {creating ? "Create key" : `Edit scope of ${editing?.key.name}`}
                        </DialogTitle>
                        <DialogDescription>
                            {creating
                                ? "The key calls only the models in its scope. The full key is shown once."
                                : "Apps using this key lose access to models you clear, within a second."}
                        </DialogDescription>
                    </DialogHeader>
                    <FieldGroup>
                        {creating && (
                            <Field
                                id="key-name"
                                label="Name"
                                hint="Shown in the key list, the request log and Callers."
                                error={touched || name ? (problem ?? undefined) : undefined}
                            >
                                <Input
                                    id="key-name"
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                    onBlur={() => setTouched(true)}
                                    placeholder="helpdesk-app"
                                    maxLength={60}
                                    required
                                    autoFocus
                                    aria-invalid={Boolean((touched || name) && problem)}
                                />
                            </Field>
                        )}
                        {showScope && (
                            <div className="flex flex-col gap-label">
                                <span className="font-medium">Scope</span>
                                <ScopeChoice value={scope} onChange={setScope} />
                            </div>
                        )}
                        {scope === "models" && (
                            <div className="flex flex-col gap-label">
                                <span className="font-medium">Models</span>
                                <ModelPicker choices={choices} picked={picked} onToggle={toggle} />
                            </div>
                        )}
                        {creating && (
                            <Field
                                id="key-expiry"
                                label="Expires"
                                hint="Install default follows the API key expiry policy."
                            >
                                <ExpirySelect value={expiry} onChange={setExpiry} />
                            </Field>
                        )}
                    </FieldGroup>
                    <ErrorLine error={save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={empty || save.isPending || (touched && Boolean(problem))}
                        >
                            {creating ? (
                                <KeyRound aria-hidden="true" />
                            ) : (
                                <Save aria-hidden="true" />
                            )}
                            {creating ? "Create key" : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
