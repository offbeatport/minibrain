import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "obp-ui";
import { type ReactNode, useState } from "react";
import { Advanced } from "./flowTrainAdvanced";
import {
    ComputeList,
    CustomNote,
    DataList,
    Footer,
    HeldOutNote,
    QualitySegments,
    Reason,
    dataText,
    fitText,
    queueText,
} from "./flowTrainParts";
import { approx, computeHours, hoursUnit } from "./flowTrainPlan";
import { type Trainer, labelOf } from "./flowTrainState";

export type Picker = "data" | "compute";

function Line({
    id,
    label,
    value,
    open,
    onToggle,
    children,
}: {
    id: string;
    label: string;
    value: ReactNode;
    open: boolean;
    onToggle: () => void;
    children?: ReactNode;
}) {
    return (
        <section aria-labelledby={`${id}-label`} className="flex flex-col gap-2 py-2.5">
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-3">
                <h3 id={`${id}-label`} className="text-muted-foreground">
                    {label}
                </h3>
                <div className="min-w-0 tabular-nums">{value}</div>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={open}
                    aria-controls={`${id}-picker`}
                    aria-label={
                        open
                            ? `Done choosing ${label.toLowerCase()}`
                            : `Change ${label.toLowerCase()}`
                    }
                    onClick={onToggle}
                >
                    {open ? "Done" : "Change"}
                </Button>
            </div>
            {open && children}
        </section>
    );
}

export function ComputeValue({ t }: { t: Trainer }) {
    const pick = t.plan.pick;
    if (!pick) {
        const issue = t.issues.find((item) => item.field === "compute");
        return issue ? (
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <Reason issue={{ ...issue, detail: null }} />
                {issue.detail && (
                    <span className="text-sm text-muted-foreground">{issue.detail}</span>
                )}
            </span>
        ) : null;
    }
    const queue = queueText(pick);
    return (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span>{`${pick.machine.name} · fits`}</span>
            <span className="text-sm text-muted-foreground">
                {[fitText(pick), queue].filter(Boolean).join(" · ")}
            </span>
        </span>
    );
}

export type PickerProps = { picker: string | null; onPicker: (picker: string | null) => void };

export function TrainMinimal({ t, picker, onPicker }: { t: Trainer } & PickerProps) {
    const [advanced, setAdvanced] = useState(false);
    const open = picker as Picker | null;
    const toggle = (which: Picker) => onPicker(open === which ? null : which);
    const pick = t.plan.pick;
    return (
        <>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7">
                <section aria-labelledby="train-quality" className="flex flex-col gap-label">
                    <div className="flex min-h-5 items-center justify-between gap-3">
                        <h3 id="train-quality" className="text-muted-foreground">
                            Quality
                        </h3>
                        <CustomNote t={t} />
                    </div>
                    <QualitySegments t={t} />
                </section>
                <div className="divide-y border-y">
                    <Line
                        id="train-data"
                        label="Data"
                        value={
                            <span className="flex flex-col gap-1">
                                <span className="flex flex-wrap items-baseline gap-x-2">
                                    <span className={t.pick ? undefined : "text-destructive"}>
                                        {dataText(t)}
                                    </span>
                                </span>
                                <HeldOutNote t={t} />
                            </span>
                        }
                        open={open === "data"}
                        onToggle={() => toggle("data")}
                    >
                        <DataList t={t} id="train-data-picker" />
                    </Line>
                    <Line
                        id="train-compute"
                        label="Compute"
                        value={<ComputeValue t={t} />}
                        open={open === "compute"}
                        onToggle={() => toggle("compute")}
                    >
                        <ComputeList t={t} id="train-compute-picker" />
                    </Line>
                </div>
                <Collapsible open={advanced} onOpenChange={setAdvanced}>
                    <div className="flex items-center gap-3">
                        <CollapsibleTrigger>Advanced</CollapsibleTrigger>
                        <span className="text-sm text-muted-foreground">
                            {t.quality ? labelOf(t.quality) : `${t.changed} changed`}
                        </span>
                    </div>
                    <CollapsibleContent className="pt-4">
                        <Advanced t={t} />
                    </CollapsibleContent>
                </Collapsible>
            </div>
            <Footer t={t}>
                {pick && (
                    <>
                        <span className="text-lg font-medium whitespace-nowrap tabular-nums">
                            {approx(pick.minutes)}
                        </span>
                        <span className="hidden text-sm whitespace-nowrap text-muted-foreground tabular-nums sm:inline">
                            {`${computeHours(pick)} ${hoursUnit(pick)}`}
                        </span>
                    </>
                )}
            </Footer>
        </>
    );
}
