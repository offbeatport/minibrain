import {
    Cpu,
    Database,
    Gauge,
    Gem,
    type LucideIcon,
    Scale,
    Server,
    SlidersHorizontal,
    Zap,
} from "lucide-react";
import { Button, DialogClose, Label, RadioGroup, RadioGroupItem, cn } from "obp-ui";
import type { ReactNode } from "react";
import { count } from "~/lib/format";
import { DatasetPicker } from "./flowDatasetPicker";
import { type RichOption, RichSelect } from "./flowSelect";
import { ComputeFields, CoreFields, DataFields, FieldGrid, OtherFields } from "./flowTrainAdvanced";
import {
    FOCUS_RING,
    HeldOutNote,
    MemoryTrack,
    Reason,
    Segments,
    Stat,
    TrainButton,
    bestOf,
    memoryText,
    qualityTime,
    versusLive,
} from "./flowTrainParts";
import {
    type ComputeChoice,
    QUALITIES,
    type Quality,
    approx,
    computeHours,
    duration,
    hoursUnit,
    presetRecipe,
} from "./flowTrainPlan";
import type { Trainer } from "./flowTrainState";
import { rate, shortAgo } from "./modelsFlowData";

type Card<T extends string> = {
    value: T;
    icon: LucideIcon;
    title: ReactNode;
    badge?: ReactNode;
    primary: ReactNode;
    secondary?: ReactNode;
    disabled?: boolean;
};

function Cards<T extends string>({
    label,
    value,
    cards,
    onChange,
    className,
}: {
    label: string;
    value: T | null;
    cards: Card<T>[];
    onChange: (value: T) => void;
    className?: string;
}) {
    return (
        <RadioGroup
            aria-label={label}
            value={value ?? ""}
            onValueChange={(next) => onChange(next as T)}
            className={cn("grid grid-cols-2 gap-2", className)}
        >
            {cards.map((card) => {
                const Icon = card.icon;
                return (
                    <Label
                        key={card.value}
                        className={cn(
                            "group/card flex cursor-pointer flex-col items-start gap-1 rounded-lg border p-3 font-normal hover:bg-secondary has-data-checked:border-primary has-data-checked:bg-accent has-data-checked:hover:bg-accent",
                            card.disabled && "cursor-not-allowed hover:bg-transparent",
                            FOCUS_RING,
                        )}
                    >
                        <RadioGroupItem
                            value={card.value}
                            disabled={card.disabled}
                            className="sr-only"
                        />
                        <span className="flex w-full items-center gap-2">
                            <Icon
                                aria-hidden
                                className={cn(
                                    "size-5 text-muted-foreground group-has-data-checked/card:text-primary",
                                    card.disabled && "opacity-50",
                                )}
                            />
                            <span
                                className={cn(
                                    "min-w-0 truncate font-medium",
                                    card.disabled && "text-muted-foreground",
                                )}
                            >
                                {card.title}
                            </span>
                            {card.badge && <span className="ml-auto">{card.badge}</span>}
                        </span>
                        <span className="text-sm tabular-nums">{card.primary}</span>
                        {card.secondary && (
                            <span className="text-sm text-muted-foreground tabular-nums">
                                {card.secondary}
                            </span>
                        )}
                    </Label>
                );
            })}
        </RadioGroup>
    );
}

const QUALITY_ICON: Record<Quality, LucideIcon> = { fast: Zap, balanced: Scale, quality: Gem };

export type QualityStyle = "cards" | "visible" | "select";

type Level = Quality | "custom";

function Section({
    id,
    label,
    aside,
    children,
}: {
    id: string;
    label: ReactNode;
    aside?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section aria-labelledby={id} className="flex flex-col gap-label">
            <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h3 id={id} className="text-muted-foreground">
                    {label}
                </h3>
                {aside}
            </div>
            {children}
        </section>
    );
}

function plural(amount: number, word: string): string {
    return `${amount} ${word}${amount === 1 ? "" : "s"}`;
}

function presetText(quality: Quality): string {
    const preset = presetRecipe(quality);
    return `rank ${preset.rank} · ${plural(preset.epochs, "epoch")} · lr ${rate(preset.learningRate)}`;
}

function presetShort(quality: Quality): string {
    const preset = presetRecipe(quality);
    return `rank ${preset.rank} · ${plural(preset.epochs, "epoch")}`;
}

function customText(t: Trainer): string {
    const { recipe } = t;
    return `rank ${recipe.rank} · ${plural(recipe.epochs, "epoch")} · lr ${rate(recipe.learningRate)}`;
}

function timeOf(t: Trainer, quality: Quality): ReactNode {
    return t.pick ? qualityTime(t.minutes[quality]) : "–";
}

function currentTime(t: Trainer): ReactNode {
    return t.pick && t.plan.pick ? approx(t.plan.pick.minutes) : "–";
}

function CoreGrid({ t }: { t: Trainer }) {
    return (
        <FieldGrid>
            <CoreFields t={t} />
        </FieldGrid>
    );
}

function QualityCards({ t }: { t: Trainer }) {
    const cards: Card<Level>[] = [
        ...QUALITIES.map((item) => ({
            value: item.id as Level,
            icon: QUALITY_ICON[item.id],
            title: item.label,
            primary: timeOf(t, item.id),
            secondary: presetShort(item.id),
        })),
        {
            value: "custom",
            icon: SlidersHorizontal,
            title: "Custom",
            primary: t.level === "custom" ? currentTime(t) : "Your values",
            secondary:
                t.level === "custom"
                    ? `rank ${t.recipe.rank} · ${plural(t.recipe.epochs, "epoch")}`
                    : "rank, epochs",
        },
    ];
    return (
        <Section id="train-quality" label="Quality">
            <Cards<Level>
                label="Quality"
                value={t.level}
                cards={cards}
                onChange={t.choose}
                className="grid-cols-2 sm:grid-cols-4"
            />
            {t.level === "custom" && (
                <div className="pt-3">
                    <CoreGrid t={t} />
                </div>
            )}
        </Section>
    );
}

function QualityVisible({ t }: { t: Trainer }) {
    return (
        <Section
            id="train-quality"
            label="Quality"
            aside={
                <span className="text-sm text-muted-foreground tabular-nums">{currentTime(t)}</span>
            }
        >
            <Segments<Level>
                label="Quality"
                value={t.level}
                onChange={t.choose}
                options={[
                    ...QUALITIES.map((item) => ({ value: item.id as Level, label: item.label })),
                    { value: "custom", label: "Custom" },
                ]}
            />
            <div className="pt-3">
                <CoreGrid t={t} />
            </div>
        </Section>
    );
}

function QualitySelect({ t }: { t: Trainer }) {
    const options: RichOption[] = [
        ...QUALITIES.map((item) => {
            const Icon = QUALITY_ICON[item.id];
            return {
                value: item.id,
                label: item.label,
                icon: <Icon />,
                meta: (
                    <>
                        {presetText(item.id)} · {timeOf(t, item.id)}
                    </>
                ),
            };
        }),
        {
            value: "custom",
            label: "Custom",
            icon: <SlidersHorizontal />,
            meta: t.level === "custom" ? customText(t) : "your values",
            separated: true,
        },
    ];
    return (
        <Section id="train-quality" label="Quality">
            <RichSelect
                id="train-quality-select"
                label="Quality"
                value={t.level}
                options={options}
                onChange={(next) => t.choose(next as Level)}
            />
            {t.level === "custom" && (
                <div className="pt-3">
                    <CoreGrid t={t} />
                </div>
            )}
        </Section>
    );
}

function DataBlock({ t }: { t: Trainer }) {
    if (t.binding) {
        return (
            <Section id="train-data" label="Dataset">
                <DatasetPicker value={t.choice} onChange={t.setChoice} />
            </Section>
        );
    }
    const options: RichOption[] = t.picks.map((pick, index) => ({
        value: String(pick.number),
        label: index === 0 ? `v${pick.number} · latest` : `v${pick.number}`,
        icon: <Database />,
        meta: [
            `${count(pick.rows)} rows`,
            shortAgo({ hoursAgo: pick.hoursAgo }),
            versusLive(t, pick.rows, pick.number),
        ]
            .filter(Boolean)
            .join(" · "),
    }));
    return (
        <Section
            id="train-data"
            label={t.dataset ? `Data · ${t.dataset.name}` : "Data"}
            aside={<HeldOutNote t={t} />}
        >
            <RichSelect
                id="train-data-version"
                label="Data version"
                value={t.pick ? String(t.pick.number) : null}
                options={options}
                onChange={(next) => t.setPicked(Number(next))}
            />
        </Section>
    );
}

function ComputeBlock({ t }: { t: Trainer }) {
    const auto = bestOf(t.plan, "auto");
    const options: RichOption[] = [
        ...t.plan.machines.map((item) => {
            const Icon = item.machine.device === "cpu" ? Cpu : Server;
            const spec = `${item.machine.memoryGb} GB · ${item.machine.accelerator.replace("NVIDIA ", "")}`;
            return {
                value: `machine:${item.machine.name}`,
                label: item.machine.name,
                icon: <Icon />,
                disabled: Boolean(t.pick) && !item.chosen,
                meta: !t.pick ? (
                    spec
                ) : item.chosen ? (
                    `${approx(item.minutes)} · ${spec}`
                ) : (
                    <span className="text-destructive">{item.reason}</span>
                ),
            };
        }),
        {
            value: "auto",
            label: "Auto",
            icon: <Gauge />,
            separated: true,
            disabled: Boolean(t.pick) && !auto,
            meta: auto ? `first free that fits · now ${auto.machine.name}` : "first free that fits",
        },
    ];
    return (
        <Section id="train-compute" label="Compute">
            <RichSelect
                id="train-compute-select"
                label="Compute"
                value={t.compute}
                options={options}
                onChange={(next) => t.setCompute(next as ComputeChoice)}
            />
        </Section>
    );
}

function AdvancedBlock({ t }: { t: Trainer }) {
    return (
        <section aria-labelledby="train-advanced" className="flex flex-col gap-field border-t pt-5">
            <div className="flex min-h-8 items-center justify-between gap-3">
                <h3 id="train-advanced" className="font-medium tabular-nums">
                    {t.changed > 0 ? `Advanced · ${t.changed} changed` : "Advanced"}
                </h3>
                {t.changed > 0 && (
                    <Button type="button" variant="ghost" onClick={t.reset}>
                        Reset
                    </Button>
                )}
            </div>
            <Section id="train-advanced-data" label="Data">
                <FieldGrid>
                    <DataFields t={t} />
                </FieldGrid>
            </Section>
            <Section id="train-advanced-compute" label="Compute">
                <FieldGrid>
                    <ComputeFields t={t} />
                </FieldGrid>
            </Section>
            <Section id="train-advanced-other" label="Other">
                <FieldGrid>
                    <OtherFields t={t} />
                </FieldGrid>
            </Section>
        </section>
    );
}

const QUALITY_BLOCK: Record<QualityStyle, (props: { t: Trainer }) => ReactNode> = {
    cards: QualityCards,
    visible: QualityVisible,
    select: QualitySelect,
};

function Settings({ t, style }: { t: Trainer; style: QualityStyle }) {
    const QualityBlock = QUALITY_BLOCK[style];
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-field overflow-y-auto overscroll-contain px-5 py-5 sm:px-7">
            <DataBlock t={t} />
            <QualityBlock t={t} />
            <ComputeBlock t={t} />
            <AdvancedBlock t={t} />
        </div>
    );
}

function Receipt({ t }: { t: Trainer }) {
    const pick = t.pick ? t.plan.pick : null;
    const shown = t.pick ? t.shown : null;
    const option = t.pick ? t.option : null;
    const queue =
        pick && pick.ahead > 0
            ? `#${pick.ahead + 1} · ${duration(pick.wait)} wait`
            : pick
              ? "Starts now"
              : "–";
    return (
        <div className="flex flex-col gap-4">
            <div aria-live="polite" className="flex flex-col gap-1">
                <span className="text-muted-foreground">Estimate</span>
                {pick ? (
                    <span className="text-2xl font-medium md:text-3xl tabular-nums">
                        {approx(pick.minutes)}
                    </span>
                ) : (
                    <span className="text-2xl font-medium md:text-3xl text-muted-foreground">
                        –
                    </span>
                )}
                {t.blocker ? (
                    <>
                        <Reason issue={{ ...t.blocker, detail: null }} />
                        {t.blocker.detail && (
                            <span className="text-sm text-muted-foreground">
                                {t.blocker.detail}
                            </span>
                        )}
                    </>
                ) : (
                    pick && (
                        <span className="text-sm text-muted-foreground">
                            {`${pick.machine.name} · ${pick.chosen?.strategy ?? ""}`}
                        </span>
                    )
                )}
            </div>
            <p className="text-sm text-muted-foreground tabular-nums md:hidden">
                {[
                    pick ? `${computeHours(pick)} ${hoursUnit(pick)}` : null,
                    shown && option ? memoryText(option, shown.machine) : null,
                ]
                    .filter(Boolean)
                    .join(" · ")}
            </p>
            <dl className="hidden flex-col gap-2.5 border-t pt-4 md:flex">
                <Stat label={pick ? hoursUnit(pick) : "GPU-hours"}>
                    {pick ? computeHours(pick) : "–"}
                </Stat>
                <div className="flex flex-col gap-1.5">
                    <Stat label="Memory">
                        {shown && option ? (
                            <span className={cn(!pick && "text-destructive")}>
                                {memoryText(option, shown.machine)}
                            </span>
                        ) : (
                            "–"
                        )}
                    </Stat>
                    {shown && option && <MemoryTrack option={option} machine={shown.machine} />}
                </div>
                <Stat label="Rows">{t.pick ? count(t.plan.rows) : "–"}</Stat>
                <Stat label="Held out">
                    {t.pick ? (
                        <span className={cn(t.lowHeldOut && "text-warning")}>
                            {count(t.heldOut)}
                        </span>
                    ) : (
                        "–"
                    )}
                </Stat>
                <Stat label="Steps">{pick ? count(pick.steps) : "–"}</Stat>
                <Stat label="Queue">{queue}</Stat>
            </dl>
        </div>
    );
}

export function TrainReceipt({ t, style }: { t: Trainer; style: QualityStyle }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_17rem] md:grid-rows-[minmax(0,1fr)]">
            <Settings t={t} style={style} />
            <aside
                aria-label="Estimate"
                className="flex shrink-0 flex-col gap-3 border-t bg-muted px-5 py-4 sm:px-6 md:gap-5 md:border-t-0 md:border-l md:py-5"
            >
                <Receipt t={t} />
                <div className="mt-auto flex gap-2">
                    <DialogClose asChild>
                        <Button type="button" variant="outline">
                            Cancel
                        </Button>
                    </DialogClose>
                    <TrainButton t={t} className="flex-1" />
                </div>
            </aside>
        </div>
    );
}
