import { History } from "lucide-react";
import { Badge, Link } from "obp-ui";
import type { ModelRow, VersionInfo } from "~/api/client";
import { useAllModels } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { PanelSection } from "~/components/Section";
import { count, percent } from "~/lib/format";
import { jobPageHref } from "~/lib/jobs";
import { metricName } from "~/lib/metrics";
import { modelCardHref, modelPageHref } from "~/lib/modelLinks";
import { exactTime } from "~/lib/time";

type Variant = "success" | "info" | "approval" | "warning" | "destructive" | "neutral";

function outcome(version: VersionInfo, deployed: boolean): { variant: Variant; label: string } {
    if (version.current && deployed) {
        return { variant: "success", label: "Live" };
    }
    if (version.status === "training") {
        return { variant: "info", label: "Training" };
    }
    if (version.status === "evaluating") {
        return { variant: "info", label: "Scoring" };
    }
    if (version.status === "failed") {
        return { variant: "destructive", label: "Failed" };
    }
    if (version.live_at) {
        return { variant: "neutral", label: "Was live" };
    }
    if (version.score === null || version.score === undefined) {
        return { variant: "neutral", label: "Ready" };
    }
    if (version.promotion && !version.promotion.passed) {
        return { variant: "warning", label: "Rejected" };
    }
    return { variant: "approval", label: "Passed" };
}

const DATE = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
});

function scoreText(version: VersionInfo): string {
    if (version.score === null || version.score === undefined) {
        return "Not scored";
    }
    return `${percent(version.score)} ${metricName(version.main_metric).toLowerCase()}`;
}

function dataText(version: VersionInfo): string {
    if (!version.dataset_version_id) {
        return "No data";
    }
    const number =
        version.dataset_version_number === null || version.dataset_version_number === undefined
            ? "Data"
            : `Data v${version.dataset_version_number}`;
    return `${number} · ${count(version.dataset_version_rows)} rows`;
}

function Attempt({
    slug,
    version,
    deployed,
}: { slug: string; version: VersionInfo; deployed: boolean }) {
    const state = outcome(version, deployed);
    const origin = version.duplicated_from;
    const job = version.job?.id ?? origin?.job;
    return (
        <li className="relative grid grid-cols-[3rem_6.5rem_minmax(10rem,1fr)_minmax(9rem,1fr)_6rem_7rem_5.5rem_2rem] items-center gap-x-4 py-2 before:absolute before:top-1/2 before:-left-6 before:w-5 before:border-t max-lg:grid-cols-[3rem_6.5rem_1fr_6rem_5.5rem_2rem]">
            <span className="font-semibold tabular-nums">{`v${version.number}`}</span>
            <span>{version.kind === "lora" ? "Trained" : "Prompt only"}</span>
            <span className="tabular-nums">{scoreText(version)}</span>
            <span className="tabular-nums text-muted-foreground max-lg:hidden">
                {dataText(version)}
            </span>
            <Badge variant={state.variant}>{state.label}</Badge>
            <time
                dateTime={version.created_at}
                title={exactTime(version.created_at)}
                className="tabular-nums text-muted-foreground max-lg:hidden"
            >
                {DATE.format(new Date(version.created_at))}
            </time>
            <Link
                href={modelCardHref(slug, version.number)}
                className="text-primary hover:underline"
            >
                Model card
            </Link>
            {job ? (
                <Link href={jobPageHref(job)} className="text-primary hover:underline">
                    Job
                </Link>
            ) : (
                <span />
            )}
            {origin && (
                <span className="col-span-full col-start-2 text-sm text-muted-foreground">
                    {"Duplicated from "}
                    <Link
                        href={modelPageHref(origin.slug, "versions")}
                        className="text-primary hover:underline"
                    >
                        {`${origin.name} v${origin.number}`}
                    </Link>
                </span>
            )}
        </li>
    );
}

type BaseGroup = { key: string; name: string; publisher: string | null; versions: VersionInfo[] };

function groups(
    row: ModelRow,
    versions: VersionInfo[],
    rows: ModelRow[],
    baseName: string,
): BaseGroup[] {
    const current = row.base_model ?? "";
    const newest = [...versions].sort((a, b) => b.number - a.number);
    const keys = [current, ...newest.map((version) => version.base_model || current)];
    return [...new Set(keys)].map((key) => {
        const base = rows.find((item) => item.kind === "base" && item.key === key);
        return {
            key,
            name: key === current ? baseName : (base?.name ?? key),
            publisher: base?.publisher ?? (key === current ? (row.publisher ?? null) : null),
            versions: newest.filter((version) => (version.base_model || current) === key),
        };
    });
}

function Group({
    row,
    group,
    current,
    deployed,
}: {
    row: ModelRow;
    group: BaseGroup;
    current: boolean;
    deployed: boolean;
}) {
    return (
        <div className="flex flex-col">
            <Link
                href={modelPageHref(group.key)}
                className="flex w-fit items-center gap-2 font-semibold hover:underline"
            >
                <PublisherLogo publisher={group.publisher} name={group.name} />
                {group.name}
                <Badge variant="outline">{current ? "Base" : "Previous base"}</Badge>
            </Link>
            {!current && (
                <p className="ml-3 border-l pt-1 pl-6 text-sm text-muted-foreground">
                    {`Made before the switch. They stay as history and can't be deployed while ${row.name} is on another base.`}
                </p>
            )}
            {group.versions.length === 0 ? (
                <p className="ml-3 border-l pt-2 pl-6 text-muted-foreground">
                    No versions yet: add training data, then train or score a prompt.
                </p>
            ) : (
                <ul className="ml-3 border-l pl-6" aria-label={`Versions built from ${group.name}`}>
                    {group.versions.map((version) => (
                        <Attempt
                            key={version.number}
                            slug={row.key}
                            version={version}
                            deployed={deployed}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}

export function VersionTimeline({
    row,
    versions,
    deployed,
    baseName,
}: {
    row: ModelRow;
    versions: VersionInfo[];
    deployed: boolean;
    baseName: string;
}) {
    const models = useAllModels();
    const found = groups(row, versions, models.data ?? [], baseName);
    const description =
        found.length > 1
            ? `Every version is a fresh attempt from its base: none builds on another. New versions are made on ${baseName}. Open one for its model card.`
            : `Every version is a fresh attempt from ${baseName}: none builds on another. Open one for its model card.`;
    return (
        <PanelSection icon={History} title="Versions" description={description}>
            <div className="flex flex-col gap-4">
                {found.map((group, index) => (
                    <Group
                        key={group.key}
                        row={row}
                        group={group}
                        current={index === 0}
                        deployed={deployed}
                    />
                ))}
            </div>
        </PanelSection>
    );
}
