import { ChevronDown, Gem, type LucideIcon, Scale, SlidersHorizontal, Zap } from "lucide-react";
import { Card, Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from "obp-ui";
import { PickSelect } from "~/components/PickSelect";
import { Advanced } from "./advanced";
import { timeText } from "./parts";
import { QUALITIES, presetText } from "./recipe";
import type { TrainRun } from "./useTrainRun";

const PRESET_ICONS: Record<(typeof QUALITIES)[number]["id"], LucideIcon> = {
    fast: Zap,
    balanced: Scale,
    quality: Gem,
};

function PresetSelect({ run }: { run: TrainRun }) {
    return (
        <PickSelect
            id="train-quality"
            compact
            large
            menuClassName="min-w-80"
            value={run.level}
            onChange={(next) => run.choose(next as typeof run.level)}
            options={[
                ...QUALITIES.map((item) => {
                    const Icon = PRESET_ICONS[item.id];
                    return {
                        value: item.id,
                        label: item.label,
                        icon: <Icon className="size-5" />,
                        description: `${presetText(item.id)} · ${timeText(run.minutes[item.id])}`,
                    };
                }),
                {
                    value: "custom",
                    label: "Custom",
                    icon: <SlidersHorizontal className="size-5" />,
                    description: "Set each parameter yourself",
                    separated: true,
                },
            ]}
        />
    );
}

function Status({ run }: { run: TrainRun }) {
    if (run.custom && run.changed > 0) {
        return (
            <button
                type="button"
                className="shrink-0 rounded-sm text-sm text-primary tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={run.reset}
            >
                {`${run.changed} changed · Reset`}
            </button>
        );
    }
    if (run.custom || !run.open) {
        return null;
    }
    return null;
}

export function TrainingCard({ run }: { run: TrainRun }) {
    return (
        <Card aria-labelledby="train-training" className="gap-0 py-0">
            <Collapsible open={run.open} onOpenChange={run.setOpen}>
                <div
                    className={cn(
                        "grid items-center gap-x-4 gap-y-2 px-panel py-3 sm:grid-cols-[9rem_minmax(0,1fr)]",
                        run.open && "border-b",
                    )}
                >
                    <h2 id="train-training" className="font-medium">
                        <label htmlFor="train-quality">Training</label>
                    </h2>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                        <div className="w-full sm:w-64">
                            <PresetSelect run={run} />
                        </div>
                        <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
                            <Status run={run} />
                            <CollapsibleTrigger
                                chevron={false}
                                aria-label={run.open ? "Hide parameters" : "Show parameters"}
                                className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <span className="text-sm">
                                    {run.open ? "Hide parameters" : "Show parameters"}
                                </span>
                                <ChevronDown
                                    aria-hidden="true"
                                    className={cn(
                                        "size-4 shrink-0 transition-transform duration-100 motion-reduce:transition-none",
                                        run.open && "rotate-180",
                                    )}
                                />
                            </CollapsibleTrigger>
                        </div>
                    </div>
                </div>
                <CollapsibleContent>
                    <div className="p-panel">
                        <Advanced
                            disabled={!run.custom}
                            recipe={run.recipe}
                            onChange={run.change}
                            plan={run.info}
                            available={run.available}
                            heldOut={run.heldOut}
                            issues={run.issues}
                            next={run.number}
                            machines={run.poolMachines}
                        />
                    </div>
                </CollapsibleContent>
            </Collapsible>
        </Card>
    );
}
