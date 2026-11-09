import {
    Button,
    CheckboxField,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldGroup,
    NumberField,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import {
    type Autopilot,
    type FlowModel,
    baseModelSlug,
    deleteModels,
    liveVersion,
    setAutopilot,
} from "./modelsFlowData";
import { plural } from "./modelsFlowRows";

export type Confirm = {
    title: string;
    description: ReactNode;
    label: string;
    run: () => void;
};

export function ConfirmDialog({
    confirm,
    onClose,
}: {
    confirm: Confirm | null;
    onClose: () => void;
}) {
    if (!confirm) {
        return null;
    }
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{confirm.title}</DialogTitle>
                    <DialogDescription asChild>
                        <div>{confirm.description}</div>
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <Button
                        variant="destructive"
                        onClick={() => {
                            confirm.run();
                            onClose();
                        }}
                    >
                        {confirm.label}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function modelFacts(model: FlowModel): string {
    if (model.kind === "base") {
        const live = model.variants.filter((item) => item.live).length;
        return `Base · ${plural(model.variants.length, "variant")}${live > 0 ? ` · ${live} live` : ""}`;
    }
    const live = liveVersion(model);
    return `${plural(model.versions.length, "version")}${live ? ` · v${live.number} live` : ""}`;
}

function dependants(models: FlowModel[], chosen: FlowModel[]): string[] {
    const bases = new Set(chosen.filter((m) => m.kind === "base").map((m) => m.slug));
    return models
        .filter(
            (model) =>
                model.kind === "custom" &&
                model.base !== null &&
                bases.has(baseModelSlug(model.base)) &&
                !chosen.includes(model),
        )
        .map((model) => model.name);
}

function DeleteSummary({ models, chosen }: { models: FlowModel[]; chosen: FlowModel[] }) {
    const versions = chosen.reduce((total, model) => total + model.versions.length, 0);
    const files = chosen.reduce((total, model) => total + model.variants.length, 0);
    const live = chosen.filter((model) => model.deployed);
    const orphans = dependants(models, chosen);
    const parts = [
        plural(chosen.length, "model"),
        versions > 0 && plural(versions, "version"),
        files > 0 && plural(files, "variant file"),
    ].filter(Boolean);
    return (
        <div className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2">
            <p className="font-medium text-destructive">{`Goes for good: ${parts.join(", ")}.`}</p>
            <p className="text-sm">
                Every API key, score, answer log and file of these models is deleted; nothing can be
                restored.
            </p>
            {live.length > 0 && (
                <p className="text-sm">
                    {`${live.map((model) => model.name).join(", ")} ${live.length === 1 ? "is" : "are"} live: apps calling ${live.length === 1 ? "it" : "them"} get errors at once.`}
                </p>
            )}
            {orphans.length > 0 && (
                <p className="text-sm">
                    {`${orphans.join(", ")} ${orphans.length === 1 ? "is" : "are"} built on a base you are deleting and cannot train or serve without it.`}
                </p>
            )}
        </div>
    );
}

export function DeleteModelsDialog({
    open,
    models,
    onOpenChange,
}: {
    open: boolean;
    models: FlowModel[];
    onOpenChange: (open: boolean) => void;
}) {
    const toast = useToast();
    const [picked, setPicked] = useState<string[]>([]);
    const chosen = models.filter((model) => picked.includes(model.slug));
    const close = (next: boolean) => {
        if (!next) {
            setPicked([]);
        }
        onOpenChange(next);
    };
    const groups: [string, FlowModel[]][] = [
        ["Your models", models.filter((model) => model.kind === "custom")],
        ["Base models", models.filter((model) => model.kind === "base")],
    ];
    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Delete models</DialogTitle>
                    <DialogDescription>
                        Tick the models to delete whole. To remove single versions or variant files,
                        select their rows in the list instead.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                    {groups.map(([label, items]) =>
                        items.length === 0 ? null : (
                            <fieldset key={label} className="flex flex-col gap-2.5">
                                <legend className="mb-2 text-sm text-muted-foreground">
                                    {label}
                                </legend>
                                {items.map((model) => (
                                    <CheckboxField
                                        key={model.slug}
                                        label={model.name}
                                        description={modelFacts(model)}
                                        checked={picked.includes(model.slug)}
                                        onCheckedChange={(value) =>
                                            setPicked(
                                                value === true
                                                    ? [...picked, model.slug]
                                                    : picked.filter((slug) => slug !== model.slug),
                                            )
                                        }
                                    />
                                ))}
                            </fieldset>
                        ),
                    )}
                </div>
                {chosen.length > 0 && <DeleteSummary models={models} chosen={chosen} />}
                <DialogFooter>
                    <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <Button
                        variant="destructive"
                        disabled={chosen.length === 0}
                        onClick={() => {
                            deleteModels(chosen.map((model) => model.slug));
                            toast({
                                title: `Deleted ${chosen.map((model) => model.name).join(", ")}`,
                                tone: "success",
                            });
                            close(false);
                        }}
                    >
                        {chosen.length === 0
                            ? "Delete"
                            : `Delete ${plural(chosen.length, "model")}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

const DEFAULT_AUTOPILOT: Autopilot = {
    threshold: 50,
    canary: 10,
    minutes: 60,
    rollbackErrors: true,
    rollbackScore: true,
    run: null,
};

function AutopilotForm({ model, onClose }: { model: FlowModel; onClose: () => void }) {
    const toast = useToast();
    const [draft, setDraft] = useState<Autopilot>(model.autopilot ?? DEFAULT_AUTOPILOT);
    const change = (patch: Partial<Autopilot>) => setDraft({ ...draft, ...patch });
    const save = () => {
        setAutopilot(model.slug, draft);
        toast({ title: `Autopilot is on for ${model.name}`, tone: "success" });
        onClose();
    };
    const turnOff = () => {
        setAutopilot(model.slug, null);
        toast({ title: `Autopilot is off for ${model.name}` });
        onClose();
    };
    return (
        <>
            <DialogHeader>
                <DialogTitle>
                    {model.autopilot
                        ? `Autopilot for ${model.name}`
                        : `Turn on autopilot for ${model.name}`}
                </DialogTitle>
                <DialogDescription>
                    Once accepted feedback reaches the threshold, it trains a new version, scores it
                    against live, sends it a canary share of traffic and deploys it when the canary
                    ends. It rolls back on any trigger below.
                </DialogDescription>
            </DialogHeader>
            <FieldGroup>
                <Field id="autopilot-threshold" label="Train when accepted feedback reaches">
                    <NumberField
                        id="autopilot-threshold"
                        value={draft.threshold}
                        onValueChange={(value) => change({ threshold: value ?? 50 })}
                        min={10}
                        max={5000}
                        step={10}
                        largeStep={100}
                        unit="rows"
                        format={{ maximumFractionDigits: 0 }}
                    />
                </Field>
                <div className="grid gap-field sm:grid-cols-2">
                    <Field id="autopilot-canary" label="Canary share">
                        <NumberField
                            id="autopilot-canary"
                            value={draft.canary}
                            onValueChange={(value) => change({ canary: value ?? 10 })}
                            min={1}
                            max={50}
                            step={5}
                            smallStep={1}
                            unit="%"
                            format={{ maximumFractionDigits: 0 }}
                        />
                    </Field>
                    <Field id="autopilot-minutes" label="Canary runs for">
                        <NumberField
                            id="autopilot-minutes"
                            value={draft.minutes}
                            onValueChange={(value) => change({ minutes: value ?? 60 })}
                            min={10}
                            max={1440}
                            step={10}
                            largeStep={60}
                            unit="min"
                            format={{ maximumFractionDigits: 0 }}
                        />
                    </Field>
                </div>
                <fieldset className="flex flex-col gap-2.5">
                    <legend className="mb-2 font-medium">Roll back if</legend>
                    <CheckboxField
                        label="Errors rise"
                        description="More than 1% of canary requests fail."
                        checked={draft.rollbackErrors}
                        onCheckedChange={(value) => change({ rollbackErrors: value === true })}
                    />
                    <CheckboxField
                        label="The score drops"
                        description="The new version scores below live on the held-out set or on rated canary answers."
                        checked={draft.rollbackScore}
                        onCheckedChange={(value) => change({ rollbackScore: value === true })}
                    />
                </fieldset>
            </FieldGroup>
            <DialogFooter>
                {model.autopilot && (
                    <Button variant="outline" className="sm:mr-auto" onClick={turnOff}>
                        Turn off
                    </Button>
                )}
                <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button onClick={save}>{model.autopilot ? "Save" : "Turn on"}</Button>
            </DialogFooter>
        </>
    );
}

export function AutopilotDialog({
    model,
    onClose,
}: {
    model: FlowModel | null;
    onClose: () => void;
}) {
    if (!model) {
        return null;
    }
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <AutopilotForm model={model} onClose={onClose} />
            </DialogContent>
        </Dialog>
    );
}
