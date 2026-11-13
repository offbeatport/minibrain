import { Cpu, Database, Gauge, Gem, type LucideIcon, Scale, Server, Zap } from "lucide-react";
import {
    Badge,
    Button,
    DialogClose,
    Label,
    RadioGroup,
    RadioGroupItem,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    cn,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { count } from "~/lib/format";
import { DatasetPicker } from "./flowDatasetPicker";
import { ComputeFields, DataFields, FieldGrid, QualityFields } from "./flowTrainAdvanced";
import {
    FOCUS_RING,
    HeldOutNote,
    MemoryTrack,
    Reason,
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
import { shortAgo } from "./modelsFlowData";

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

function Section({
    id,
    label,
    aside,
    children,
}: {
    id: string;
    label: string;
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

function General({ t }: { t: Trainer }) {
    const auto = bestOf(t.plan, "auto");
    const qualityCards = QUALITIES.map((item) => {
        const preset = presetRecipe(item.id);
        return {
            value: item.id,
            icon: QUALITY_ICON[item.id],
            title: item.label,
            primary: t.pick ? qualityTime(t.minutes[item.id]) : "–",
            secondary: `rank ${preset.rank} · ${plural(preset.epochs, "epoch")}`,
        };
    });
    const dataCards = t.picks.map((pick, index) => ({
        value: String(pick.number),
        icon: Database,
        title: `v${pick.number}`,
        badge: index === 0 ? <Badge variant="info">Latest</Badge> : undefined,
        primary: `${count(pick.rows)} rows`,
        secondary: [shortAgo({ hoursAgo: pick.hoursAgo }), versusLive(t, pick.rows, pick.number)]
            .filter(Boolean)
            .join(" · "),
    }));
    const computeCards: Card<ComputeChoice>[] = [
        ...t.plan.machines.map((item) => ({
            value: `machine:${item.machine.name}` as ComputeChoice,
            icon: item.machine.device === "cpu" ? Cpu : Server,
            title: item.machine.name,
            primary: !t.pick ? (
                "–"
            ) : item.chosen ? (
                approx(item.minutes)
            ) : (
                <span className="text-destructive">{item.reason}</span>
            ),
            secondary: `${item.machine.memoryGb} GB · ${item.machine.accelerator.replace("NVIDIA ", "")}`,
            disabled: !item.chosen,
        })),
        {
            value: "auto",
            icon: Gauge,
            title: "Auto",
            primary: !t.pick ? (
                "–"
            ) : auto ? (
                approx(auto.minutes)
            ) : (
                <span className="text-destructive">nothing fits</span>
            ),
            secondary: auto?.machine.name,
            disabled: !auto,
        },
    ];
    return (
        <>
            {t.binding && (
                <Section id="train-data" label="Dataset">
                    <DatasetPicker
                        value={t.choice}
                        onChange={t.setChoice}
                        className="sm:grid-cols-2"
                    />
                </Section>
            )}
            <Section id="train-quality" label="Quality">
                <Cards<Quality>
                    label="Quality"
                    value={t.quality}
                    cards={qualityCards}
                    onChange={t.choose}
                    className="grid-cols-1 sm:grid-cols-3"
                />
            </Section>
            {!t.binding && (
                <Section
                    id="train-data"
                    label={t.dataset ? `Data · ${t.dataset.slug}` : "Data"}
                    aside={<HeldOutNote t={t} />}
                >
                    {t.pick && (
                        <Cards<string>
                            label="Data version"
                            value={String(t.pick.number)}
                            cards={dataCards}
                            onChange={(next) => t.setPicked(Number(next))}
                            className="grid-cols-1 sm:grid-cols-3"
                        />
                    )}
                </Section>
            )}
            <Section id="train-compute" label="Compute">
                <Cards<ComputeChoice>
                    label="Compute"
                    value={t.compute}
                    cards={computeCards}
                    onChange={t.setCompute}
                    className="sm:grid-cols-4"
                />
            </Section>
        </>
    );
}

function AdvancedGroups({ t }: { t: Trainer }) {
    return (
        <>
            <Section id="train-advanced-quality" label="Quality">
                <FieldGrid>
                    <QualityFields t={t} />
                </FieldGrid>
            </Section>
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
        </>
    );
}

type Tab = "general" | "advanced";

const PANEL =
    "flex min-h-0 flex-1 flex-col gap-field overflow-y-auto overscroll-contain px-5 py-5 sm:px-7";

function Settings({ t }: { t: Trainer }) {
    const [tab, setTab] = useState<Tab>("general");
    return (
        <Tabs
            value={tab}
            onValueChange={(next) => setTab(next as Tab)}
            className="min-h-0 flex-1 gap-0"
        >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-5 py-3 sm:px-7">
                <TabsList aria-label="Settings">
                    <TabsTrigger value="general">General</TabsTrigger>
                    <TabsTrigger value="advanced" className="tabular-nums">
                        {t.changed > 0 ? `Advanced · ${t.changed} changed` : "Advanced"}
                    </TabsTrigger>
                </TabsList>
                {t.changed > 0 && (
                    <Button type="button" variant="ghost" onClick={t.reset}>
                        Reset
                    </Button>
                )}
            </div>
            <TabsContent value="general" className={PANEL}>
                <General t={t} />
            </TabsContent>
            <TabsContent value="advanced" className={PANEL}>
                <AdvancedGroups t={t} />
            </TabsContent>
        </Tabs>
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

export function TrainReceipt({ t }: { t: Trainer }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_17rem] md:grid-rows-[minmax(0,1fr)]">
            <Settings t={t} />
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
