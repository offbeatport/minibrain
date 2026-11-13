import { Dialog, DialogContent, DialogTitle, cn } from "obp-ui";
import { type KeyboardEvent, useState } from "react";
import { closeTrain, useCan, useOverlays } from "./flowOverlays";
import { Segments } from "./flowTrainParts";
import { type QualityStyle, TrainReceipt } from "./flowTrainReceipt";
import { useTrainer } from "./flowTrainState";
import { type FlowModel, useFlowState } from "./modelsFlowData";

type Variant = "1" | "2" | "3";

const VARIANT_KEY = "minibrain.proto.flow.trainVariant.v3";
const VARIANTS: Variant[] = ["1", "2", "3"];

const STYLE: Record<Variant, QualityStyle> = { "1": "cards", "2": "visible", "3": "select" };

const SIZE = "h-[calc(100dvh-2rem)] sm:h-[min(40rem,calc(100dvh-2rem))] sm:max-w-[62rem]";

function readVariant(): Variant {
    try {
        const stored = window.localStorage.getItem(VARIANT_KEY);
        return VARIANTS.find((item) => item === stored) ?? "1";
    } catch {
        return "1";
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
        return (
            root?.querySelector<HTMLElement>(
                variant === "1"
                    ? "form > :not(header) [role=radio][data-checked]"
                    : "form > :not(header) button[role=combobox]",
            ) ?? null
        );
    };
}

function Body({
    model,
    variant,
    onVariant,
}: {
    model: FlowModel;
    variant: Variant;
    onVariant: (variant: Variant) => void;
}) {
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
            <TrainReceipt t={t} style={STYLE[variant]} />
        </form>
    );
}

export function TrainDialog() {
    const { train } = useOverlays();
    const state = useFlowState();
    const allowed = useCan("builder");
    const [variant, setVariant] = useState<Variant>(readVariant);
    const model = train && allowed ? state.models.find((item) => item.slug === train) : undefined;
    const choose = (next: Variant) => {
        setVariant(next);
        writeVariant(next);
    };
    const onOpenChange = (open: boolean) => {
        if (!open) {
            closeTrain();
        }
    };
    return (
        <Dialog open={Boolean(model)} onOpenChange={onOpenChange}>
            <DialogContent
                data-train-dialog
                initialFocus={initialFocus(variant)}
                className={cn(
                    "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0",
                    SIZE,
                )}
            >
                {model && <Body model={model} variant={variant} onVariant={choose} />}
            </DialogContent>
        </Dialog>
    );
}
