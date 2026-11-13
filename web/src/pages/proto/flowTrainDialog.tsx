import { Dialog, DialogContent, DialogTitle, cn } from "obp-ui";
import { type KeyboardEvent, useState } from "react";
import { closeTrain, useCan, useOverlays } from "./flowOverlays";
import { type PickerProps, TrainMinimal } from "./flowTrainMinimal";
import { Segments } from "./flowTrainParts";
import { TrainReceipt } from "./flowTrainReceipt";
import { useTrainer } from "./flowTrainState";
import { TrainSummary } from "./flowTrainSummary";
import { type FlowModel, useFlowState } from "./modelsFlowData";

type Variant = "A" | "B" | "C";

const VARIANT_KEY = "minibrain.proto.flow.trainVariant.v2";
const VARIANTS: Variant[] = ["A", "B", "C"];

const WIDTH: Record<Variant, string> = {
    A: "sm:max-w-[36rem]",
    B: "sm:max-w-[48rem]",
    C: "h-[calc(100dvh-2rem)] sm:h-[min(40rem,calc(100dvh-2rem))] sm:max-w-[62rem]",
};

function readVariant(): Variant {
    try {
        const stored = window.localStorage.getItem(VARIANT_KEY);
        return VARIANTS.find((item) => item === stored) ?? "C";
    } catch {
        return "C";
    }
}

function writeVariant(variant: Variant) {
    try {
        window.localStorage.setItem(VARIANT_KEY, variant);
    } catch {
        return;
    }
}

function submitsOnEnter(target: HTMLElement): boolean {
    if (target.closest("[data-variant-switch]")) {
        return false;
    }
    if (target.getAttribute("role") === "radio") {
        return true;
    }
    return target instanceof HTMLInputElement && target.getAttribute("aria-expanded") !== "true";
}

function initialFocus(variant: Variant): () => HTMLElement | null {
    return () => {
        const root = document.querySelector<HTMLElement>("[data-train-dialog]");
        const selector =
            variant === "B"
                ? "button[type=submit]:not(:disabled)"
                : "form > :not(header) [role=radio][data-checked]";
        return root?.querySelector<HTMLElement>(selector) ?? null;
    };
}

function Body({
    model,
    variant,
    onVariant,
    picker,
    onPicker,
}: {
    model: FlowModel;
    variant: Variant;
    onVariant: (variant: Variant) => void;
} & PickerProps) {
    const t = useTrainer(model);
    const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }
        if (submitsOnEnter(event.target as HTMLElement)) {
            event.preventDefault();
            t.start();
        }
    };
    return (
        <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
                event.preventDefault();
                t.start();
            }}
            onKeyDown={onKeyDown}
        >
            <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-5 pr-14 pl-5 sm:pl-7">
                <DialogTitle className="mr-auto min-w-0 truncate pr-0">
                    {`Train v${t.number} · ${model.name}`}
                </DialogTitle>
                <div
                    data-variant-switch
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                    <span aria-hidden>Variant</span>
                    <Segments<Variant>
                        label="Design variant"
                        value={variant}
                        onChange={onVariant}
                        compact
                        options={VARIANTS.map((item) => ({ value: item, label: item }))}
                    />
                </div>
            </header>
            {variant === "A" && <TrainMinimal t={t} picker={picker} onPicker={onPicker} />}
            {variant === "B" && <TrainSummary t={t} picker={picker} onPicker={onPicker} />}
            {variant === "C" && <TrainReceipt t={t} />}
        </form>
    );
}

export function TrainDialog() {
    const { train } = useOverlays();
    const state = useFlowState();
    const allowed = useCan("builder");
    const [variant, setVariant] = useState<Variant>(readVariant);
    const model = train && allowed ? state.models.find((item) => item.slug === train) : undefined;
    const [picker, setPicker] = useState<string | null>(null);
    const choose = (next: Variant) => {
        setVariant(next);
        setPicker(null);
        writeVariant(next);
    };
    const onOpenChange = (open: boolean, details: { reason: string; cancel: () => void }) => {
        if (open) {
            return;
        }
        if (picker && details.reason === "escape-key") {
            details.cancel();
            document
                .querySelector<HTMLElement>(
                    "[data-train-dialog] [aria-expanded=true][aria-controls]",
                )
                ?.focus();
            setPicker(null);
            return;
        }
        setPicker(null);
        closeTrain();
    };
    return (
        <Dialog open={Boolean(model)} onOpenChange={onOpenChange}>
            <DialogContent
                data-train-dialog
                initialFocus={initialFocus(variant)}
                className={cn(
                    "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0",
                    WIDTH[variant],
                )}
            >
                {model && (
                    <Body
                        model={model}
                        variant={variant}
                        onVariant={choose}
                        picker={picker}
                        onPicker={setPicker}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
