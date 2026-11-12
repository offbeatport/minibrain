import { ChevronDown } from "lucide-react";
import { cn } from "obp-ui";
import { type ReactNode, useEffect, useRef } from "react";
import { count } from "~/lib/format";
import { Advanced } from "./flowTrainAdvanced";
import type { PickerProps } from "./flowTrainMinimal";
import {
    ComputeList,
    CustomNote,
    DataList,
    Footer,
    HeldOutNote,
    QualitySegments,
    fitText,
    queueText,
} from "./flowTrainParts";
import { approx } from "./flowTrainPlan";
import { type Trainer, labelOf } from "./flowTrainState";

type Part = "quality" | "compute" | "data" | "settings";

const PART_LABEL: Record<Part, string> = {
    quality: "Quality",
    compute: "Compute",
    data: "Data",
    settings: "Settings",
};

function Chip({
    part,
    open,
    danger,
    onToggle,
    children,
}: {
    part: Part;
    open: boolean;
    danger?: boolean;
    onToggle: (part: Part) => void;
    children: ReactNode;
}) {
    return (
        <span className="inline-flex items-center gap-2">
            <span aria-hidden className="text-muted-foreground">
                ·
            </span>
            <button
                type="button"
                data-chip={part}
                aria-expanded={open}
                aria-controls="train-summary-picker"
                aria-label={`${PART_LABEL[part]}: ${typeof children === "string" ? children : ""}`}
                onClick={() => onToggle(part)}
                className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-input-background px-2.5 tabular-nums hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
                    open && "border-primary bg-accent text-accent-foreground hover:bg-accent",
                    danger && "border-destructive text-destructive",
                )}
            >
                {children}
                <ChevronDown
                    aria-hidden
                    className={cn("size-4 text-muted-foreground", open && "rotate-180")}
                />
            </button>
        </span>
    );
}

function Picker({ t, part }: { t: Trainer; part: Part }) {
    if (part === "quality") {
        return (
            <div className="flex flex-col gap-2">
                <QualitySegments t={t} />
                <CustomNote t={t} />
            </div>
        );
    }
    if (part === "data") {
        return <DataList t={t} />;
    }
    if (part === "compute") {
        return <ComputeList t={t} />;
    }
    return <Advanced t={t} />;
}

export function TrainSummary({ t, picker, onPicker }: { t: Trainer } & PickerProps) {
    const open = picker as Part | null;
    const panel = useRef<HTMLFieldSetElement>(null);
    const pick = t.plan.pick;
    const computeIssue = t.issues.find((item) => item.field === "compute");
    const settingsIssue = t.issues.some((item) => item.field !== "compute");

    useEffect(() => {
        if (open) {
            panel.current
                ?.querySelector<HTMLElement>(
                    "[role=radio][data-checked], [role=radio]:not([data-disabled]), input, button",
                )
                ?.focus();
        }
    }, [open]);

    const toggle = (part: Part) => onPicker(open === part ? null : part);

    const time = pick ? `${approx(pick.minutes)} on ${pick.machine.name}` : computeIssue?.text;
    const settings = t.quality ? "Settings" : `${t.changed} changed`;
    const meta = [
        t.dataset && t.pick ? `${t.dataset.slug} v${t.pick.number}` : null,
        t.base.name,
        pick ? fitText(pick) : (computeIssue?.detail ?? null),
        pick ? queueText(pick) : null,
        t.accepted > 0 ? `+${count(t.accepted)} feedback` : null,
    ].filter(Boolean);

    return (
        <>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 py-5 sm:px-7">
                <div className="rounded-lg border">
                    <div className="flex flex-col gap-3 p-5">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-2 text-lg">
                            <span className="text-2xl font-medium tabular-nums">{`v${t.number}`}</span>
                            <Chip part="quality" open={open === "quality"} onToggle={toggle}>
                                {t.quality ? labelOf(t.quality) : "Custom"}
                            </Chip>
                            <Chip
                                part="compute"
                                open={open === "compute"}
                                danger={!pick}
                                onToggle={toggle}
                            >
                                {time ?? "Compute"}
                            </Chip>
                            <Chip
                                part="data"
                                open={open === "data"}
                                danger={!t.pick}
                                onToggle={toggle}
                            >
                                {t.pick ? `${count(t.plan.rows)} rows` : "No dataset"}
                            </Chip>
                            <Chip
                                part="settings"
                                open={open === "settings"}
                                danger={settingsIssue}
                                onToggle={toggle}
                            >
                                {settings}
                            </Chip>
                        </p>
                        <p className="text-sm text-muted-foreground tabular-nums">
                            {meta.join(" · ")}
                        </p>
                        <HeldOutNote t={t} />
                    </div>
                    {open && (
                        <fieldset
                            ref={panel}
                            id="train-summary-picker"
                            aria-label={PART_LABEL[open]}
                            className="min-w-0 border-t p-5"
                        >
                            <Picker t={t} part={open} />
                        </fieldset>
                    )}
                </div>
            </div>
            <Footer t={t} />
        </>
    );
}
