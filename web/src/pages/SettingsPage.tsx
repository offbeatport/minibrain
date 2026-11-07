import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Coins, GraduationCap, Palette, Scale, Split } from "lucide-react";
import {
    Button,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Switch,
} from "obp-ui";
import { useState } from "react";
import { api, unwrap } from "~/api/client";
import { keys, useAllModels, useCatalog, useInstallSettings, useJudgeSetting } from "~/api/queries";
import type { components } from "~/api/schema";
import { NumberSettingRow } from "~/components/NumberSettingRow";
import { InstallSafety } from "~/components/SafetySettings";
import { ErrorLine, PanelSection, PanelSections, Stat, errorMessage } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { SourceBadge } from "~/components/SourceBadge";
import { ThemeChoice } from "~/components/ThemeChoice";
import { useCan } from "~/lib/access";
import { CURRENCIES } from "~/lib/cost";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import { useModelsRefresh } from "./models/dialogs";
import { GENERAL } from "./settings/settingsIndex";

const SPLIT_LABELS: Record<string, string> = {
    golden: "Test set (max)",
    eval: "Held-out (max)",
    shots: "Few-shot (max)",
    min_rows: "Minimum rows",
};

function Appearance() {
    return (
        <PanelSection
            icon={Palette}
            anchor={GENERAL.appearance.anchor}
            title={GENERAL.appearance.title}
        >
            <ThemeChoice />
        </PanelSection>
    );
}

const CATALOGUE = GENERAL.catalogue;
const PRICES = GENERAL.prices;
const JUDGE = GENERAL.judge;
const OWN_BASE = "own-base";

function ModelCatalogue() {
    const refresh = useModelsRefresh();
    const catalog = useCatalog();
    const settings = useQuery({
        queryKey: ["catalog", "settings"],
        queryFn: () => unwrap(api.GET("/api/catalog/settings")),
    });
    const [dailyOn, setDailyOn] = useState<boolean | null>(null);
    const sync = useMutation({
        mutationFn: () => unwrap(api.POST("/api/catalog/sync")),
        onSuccess: refresh,
    });
    const daily = useMutation({
        mutationFn: (value: boolean) =>
            unwrap(api.PUT("/api/catalog/settings", { body: { daily_sync: value } })),
    });
    const data = catalog.data;
    const syncing = data?.sync_job && ["queued", "running"].includes(data.sync_job.status);
    const dailyLocked = settings.data?.daily_sync_locked;
    const checked = data?.synced_at
        ? `Checked for updates ${relativeTime(data.synced_at)}`
        : "Using the catalogue bundled with this release";
    return (
        <PanelSection icon={BookMarked} anchor={CATALOGUE.anchor} title={CATALOGUE.title}>
            <SettingsGroup>
                <SettingsRow
                    anchor={CATALOGUE.settings.catalogueUpdates.anchor}
                    label={CATALOGUE.settings.catalogueUpdates.label}
                    description={`${checked}${data?.sync_job?.status === "failed" ? "; the last check failed" : ""}.`}
                    error={errorMessage(sync.error)}
                    control={
                        <Button
                            variant="outline"
                            onClick={() => sync.mutate()}
                            disabled={data?.online === false || Boolean(syncing) || sync.isPending}
                        >
                            {syncing ? "Checking…" : "Check for updates"}
                        </Button>
                    }
                />
                <SettingsRow
                    id="daily-sync-switch"
                    anchor={CATALOGUE.settings.dailySync.anchor}
                    toggle
                    disabled={data?.offline_forced || Boolean(dailyLocked)}
                    label={CATALOGUE.settings.dailySync.label}
                    description={
                        data?.offline_forced
                            ? "Off while this install cannot reach the model hub."
                            : CATALOGUE.settings.dailySync.description
                    }
                    error={errorMessage(daily.error)}
                    control={
                        <>
                            <Switch
                                id="daily-sync-switch"
                                checked={dailyOn ?? settings.data?.daily_sync ?? false}
                                disabled={data?.offline_forced || Boolean(dailyLocked)}
                                readOnly={daily.isPending}
                                onCheckedChange={(next) => {
                                    setDailyOn(next);
                                    daily.mutate(next);
                                }}
                            />
                            {dailyLocked && <SourceBadge source={dailyLocked} />}
                        </>
                    }
                />
            </SettingsGroup>
        </PanelSection>
    );
}

type PoolPrice = components["schemas"]["PoolPrice"];
type PricesUpdate = components["schemas"]["DevicePricesUpdate"];

const PRICES_KEY = ["compute", "prices"] as const;
const MAX_HOURLY_PRICE = 1_000_000;

function useSavePrices() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (body: PricesUpdate) => unwrap(api.PUT("/api/compute/prices", { body })),
        onSuccess: async (saved) => {
            client.setQueryData(PRICES_KEY, saved);
            await client.invalidateQueries({
                predicate: (query) => query.queryKey[0] !== "compute",
            });
        },
    });
}

function CurrencyRow({ value, locked }: { value: string | undefined; locked?: string | null }) {
    const save = useSavePrices();
    const choices = value && !CURRENCIES.includes(value) ? [value, ...CURRENCIES] : CURRENCIES;
    return (
        <SettingsRow
            id="price-currency"
            anchor={PRICES.settings.currency.anchor}
            label={PRICES.settings.currency.label}
            description={PRICES.settings.currency.description}
            error={errorMessage(save.error)}
            disabled={Boolean(locked)}
            control={
                locked ? (
                    <>
                        <span>{value}</span>
                        <SourceBadge source={locked} />
                    </>
                ) : (
                    <Select
                        value={value ?? "USD"}
                        onValueChange={(next) => save.mutate({ currency: String(next) })}
                    >
                        <SelectTrigger
                            id="price-currency"
                            aria-describedby="price-currency-description"
                            className="w-32"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {choices.map((code) => (
                                <SelectItem key={code} value={code}>
                                    {code}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )
            }
        />
    );
}

function poolDescription(pool: PoolPrice): string {
    const machines = pool.accelerators.length
        ? pool.accelerators.join("; ")
        : "No machine reports here now";
    return `${machines}. 0 shows GPU time instead of cost.`;
}

function PoolPriceRow({ pool, currency }: { pool: PoolPrice; currency: string }) {
    const save = useSavePrices();
    return (
        <NumberSettingRow
            id={`price-${pool.pool}`}
            label={pool.pool === "local" ? pool.label : `Pool ${pool.label}`}
            description={poolDescription(pool)}
            value={pool.hourly_price ?? 0}
            min={0}
            max={MAX_HOURLY_PRICE}
            step={0.1}
            largeStep={1}
            format={{ style: "currency", currency, maximumFractionDigits: 4 }}
            unit="per hour"
            groupClassName="w-36"
            locked={pool.locked}
            pending={save.isPending}
            error={save.error}
            onSave={(next, saved) =>
                save.mutate({ hourly: { [pool.pool]: next } }, { onSuccess: saved })
            }
        />
    );
}

function ComputePrices() {
    const prices = useQuery({
        queryKey: PRICES_KEY,
        queryFn: () => unwrap(api.GET("/api/compute/prices")),
    });
    const data = prices.data;
    return (
        <PanelSection
            icon={Coins}
            anchor={PRICES.anchor}
            title={PRICES.title}
            description="Scoring measures GPU time per request. A price per hour turns it into cost per 1,000 requests; without one, Evaluations and model cards show the time."
        >
            <ErrorLine error={prices.error} />
            <SettingsGroup>
                <CurrencyRow value={data?.currency} locked={data?.currency_locked} />
                {(data?.pools ?? []).map((pool) => (
                    <PoolPriceRow key={pool.pool} pool={pool} currency={data?.currency ?? "USD"} />
                ))}
            </SettingsGroup>
        </PanelSection>
    );
}

function JudgeModel() {
    const client = useQueryClient();
    const setting = useJudgeSetting();
    const models = useAllModels();
    const save = useMutation({
        mutationFn: (model: string | null) =>
            unwrap(api.PUT("/api/settings/judge", { body: { model } })),
        onSuccess: async (saved) => {
            client.setQueryData(keys.judge, saved);
            await client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "model" });
        },
    });
    const chosen = setting.data?.model;
    const bases = (models.data ?? []).filter(
        (row) =>
            row.kind === "base" && (row.availability.state === "available" || row.key === chosen),
    );
    const value = save.isPending ? (save.variables ?? OWN_BASE) : (setting.data?.model ?? OWN_BASE);
    return (
        <PanelSection
            icon={Scale}
            anchor={JUDGE.anchor}
            title={JUDGE.title}
            description="A judge scores free-text answers from 1 to 5 against a rubric, as its own job on this install, and says why. Chat assistants add a judge score once one is chosen; a model can pick its own on its page."
        >
            <SettingsGroup>
                <SettingsRow
                    id="judge-model-select"
                    anchor={JUDGE.settings.judgeModel.anchor}
                    label={JUDGE.settings.judgeModel.label}
                    description={JUDGE.settings.judgeModel.description}
                    error={errorMessage(save.error ?? setting.error)}
                    control={
                        <Select
                            value={value}
                            onValueChange={(next) =>
                                save.mutate(!next || next === OWN_BASE ? null : String(next))
                            }
                        >
                            <SelectTrigger id="judge-model-select" className="w-64">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    value={OWN_BASE}
                                    description="No judge score unless a model turns it on"
                                >
                                    None chosen
                                </SelectItem>
                                {bases.map((row) => (
                                    <SelectItem key={row.key} value={row.key}>
                                        {row.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    }
                />
            </SettingsGroup>
        </PanelSection>
    );
}

export function SettingsPage() {
    const { data, error } = useInstallSettings();
    const can = useCan();
    return (
        <SettingsLayout title="General">
            <ErrorLine error={error} />
            <PanelSections>
                <Appearance />
                {can.admin && <ModelCatalogue />}
                {can.admin && <ComputePrices />}
                {can.admin && <JudgeModel />}
                {can.admin && <InstallSafety />}
                <PanelSection
                    icon={GraduationCap}
                    anchor={GENERAL.recipe.anchor}
                    title={GENERAL.recipe.title}
                >
                    <div className="flex flex-wrap gap-8">
                        {Object.entries(data?.recipe ?? {}).map(([key, value]) => (
                            <Stat
                                key={key}
                                label={key.replaceAll("_", " ")}
                                value={<span className="font-mono">{String(value)}</span>}
                            />
                        ))}
                    </div>
                </PanelSection>
                <PanelSection
                    icon={Split}
                    anchor={GENERAL.splits.anchor}
                    title={GENERAL.splits.title}
                >
                    <div className="flex flex-wrap gap-8">
                        {Object.entries(data?.splits ?? {}).map(([key, value]) => (
                            <Stat key={key} label={SPLIT_LABELS[key] ?? key} value={count(value)} />
                        ))}
                    </div>
                </PanelSection>
            </PanelSections>
        </SettingsLayout>
    );
}
