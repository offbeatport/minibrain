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
import { type Autopilot, type FlowModel, setAutopilot } from "./modelsFlowData";

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

const DEFAULT_AUTOPILOT: Autopilot = {
    threshold: 50,
    canary: 10,
    minutes: 60,
    revertOnErrors: true,
    revertOnScore: true,
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
                    ends. Any trigger below makes the previous version live again.
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
                    <legend className="mb-2 font-medium">
                        Make the previous version live again if
                    </legend>
                    <CheckboxField
                        label="Errors rise"
                        description="More than 1% of canary requests fail."
                        checked={draft.revertOnErrors}
                        onCheckedChange={(value) => change({ revertOnErrors: value === true })}
                    />
                    <CheckboxField
                        label="The score drops"
                        description="The new version scores below live on the held-out set or on rated canary answers."
                        checked={draft.revertOnScore}
                        onCheckedChange={(value) => change({ revertOnScore: value === true })}
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
