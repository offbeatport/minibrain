import {
    CircleAlert,
    CircleCheck,
    CircleDashed,
    LoaderCircle,
    type LucideIcon,
} from "lucide-react";
import { Link, Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import { Fragment, type ReactElement, type ReactNode } from "react";
import type { BaseModelDetail, ModelDetail, ModelRow } from "~/api/client";
import { CopyButton } from "~/components/CopyButton";
import { type Crumb, PageHeader } from "~/components/PageHeader";
import { PoolLink } from "~/components/PoolLink";
import { PublisherLogo } from "~/components/PublisherLogo";
import type { Tone } from "~/components/models/StatusText";
import { modelPageHref } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import { beingDeleted, busyTearingDown, setDeployed } from "~/lib/teardown";
import type { Confirmation } from "../dialogs";
import { parametersText } from "./facts";

export type Fact = ReactElement | null | false;

export function Inline({ items }: { items: Fact[] }) {
    const shown = items.filter((item): item is ReactElement => Boolean(item));
    return (
        <>
            {shown.map((item, index) => (
                <Fragment key={item.key}>
                    {index > 0 && (
                        <span aria-hidden="true" className="text-faint">
                            ·
                        </span>
                    )}
                    {item}
                </Fragment>
            ))}
        </>
    );
}

export function modelCrumbs(row: ModelRow, more: Crumb[] = []): Crumb[] {
    return [
        { label: "Models", href: modelsHref() },
        { label: row.name, href: more.length > 0 ? modelPageHref(row.key) : undefined },
        ...more,
    ];
}

export function Tip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
    if (!tip) {
        return children;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">{children}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{tip}</TooltipContent>
        </Tooltip>
    );
}

export function InlineFacts({ items }: { items: Fact[] }) {
    return (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
            <Inline items={items} />
        </span>
    );
}

export function isDeployed(row: ModelRow): boolean {
    return row.deployment.state !== "not_deployed";
}

export function nextVersion(row: ModelRow): number {
    const highest = Math.max(0, ...(row.versions ?? []).map((version) => version.number + 1));
    return Math.max(highest, row.next_version ?? 0);
}

function trimmed(text: string): string {
    return text.trim().replace(/\.$/, "");
}

export function baseNameOf(rows: ModelRow[] | undefined, key: string | null | undefined): string {
    return rows?.find((item) => item.key === key)?.name ?? key ?? "";
}

function subtitleOf(row: ModelRow, base: BaseModelDetail | undefined): string {
    if (row.kind === "custom") {
        return row.description ? trimmed(row.description) : "";
    }
    return [
        row.description ? trimmed(row.description) : null,
        base?.publisher ?? row.publisher,
        base?.parameters ? `${parametersText(base.parameters)} parameters` : null,
        base?.license_name ?? base?.license,
    ]
        .filter(Boolean)
        .join(" · ");
}

export function ModelAvatar({ row, size = "md" }: { row: ModelRow; size?: "sm" | "md" | "lg" }) {
    return (
        <PublisherLogo
            publisher={row.kind === "base" ? row.publisher : null}
            name={row.name}
            size={size}
            custom={row.kind === "custom"}
            avatar={row.avatar}
        />
    );
}

type Shown = { tone: Tone; label: string; href?: string; pool?: string; joiner?: string };

function deploymentShown(row: ModelRow): Shown {
    const version =
        row.kind === "custom" && row.current_version !== null ? ` v${row.current_version}` : "";
    const job = row.teardown?.jobs?.[0];
    const jobLink = job ? `/jobs/${job}` : undefined;
    const pool = row.deployment.pool ?? undefined;
    switch (row.deployment.state) {
        case "running":
            return {
                tone: "success",
                label: version ? `Deployed ·${version}` : "Deployed",
                pool,
                joiner: " on ",
            };
        case "starting":
            return row.deployment.waiting
                ? { tone: "warning", label: "Waiting for a machine", pool, joiner: " in " }
                : { tone: "info", label: `Deploying${version}`, pool, joiner: " on " };
        case "unhealthy":
            return {
                tone: "destructive",
                label: "Deploy failed",
                href: modelPageHref(row.key, "monitoring"),
            };
        case "stopping":
            return { tone: "info", label: "Undeploying…", href: jobLink };
        case "stop_failed":
            return { tone: "destructive", label: "Undeploy failed", href: jobLink };
        default:
            return { tone: "neutral", label: "Not deployed" };
    }
}

const STATUS_ICONS: Record<Tone, { icon: LucideIcon; className: string }> = {
    success: { icon: CircleCheck, className: "text-success" },
    info: { icon: LoaderCircle, className: "animate-spin text-info motion-reduce:animate-none" },
    warning: { icon: CircleAlert, className: "text-warning" },
    destructive: { icon: CircleAlert, className: "text-destructive" },
    neutral: { icon: CircleDashed, className: "text-muted-foreground" },
};

export function DeploymentStatus({ row, brief = false }: { row: ModelRow; brief?: boolean }) {
    const shown = deploymentShown(row);
    const { icon: Icon, className } = STATUS_ICONS[shown.tone];
    const text = (
        <span
            className={cn(
                "inline-flex items-center gap-1.5",
                shown.tone === "destructive"
                    ? "text-destructive"
                    : shown.tone === "neutral"
                      ? "text-muted-foreground"
                      : undefined,
            )}
        >
            <Icon aria-hidden="true" className={cn("size-4 shrink-0", className)} />
            <span>
                {shown.label}
                {shown.pool && (
                    <>
                        {shown.joiner}
                        <PoolLink name={shown.pool} />
                    </>
                )}
                {!brief && shown.pool && row.deployment.moving_to && (
                    <>
                        {" · moving to "}
                        <PoolLink name={row.deployment.moving_to} />
                    </>
                )}
                {!brief && shown.pool && (row.deployment.replicas ?? 1) > 1 && (
                    <span className="tabular-nums">{` · ${row.deployment.replicas} replicas`}</span>
                )}
            </span>
        </span>
    );
    return shown.href ? (
        <Link href={shown.href} className="text-inherit hover:underline">
            {text}
        </Link>
    ) : (
        text
    );
}

export function ModelHeader({
    row,
    base,
    actions,
}: {
    row: ModelRow;
    base: BaseModelDetail | undefined;
    actions: ReactNode;
}) {
    const description = subtitleOf(row, base);
    return (
        <PageHeader
            icon={<ModelAvatar row={row} size="lg" />}
            title={row.name}
            crumbs={modelCrumbs(row)}
            badge={<DeploymentStatus row={row} />}
            caption={
                <InlineFacts
                    items={[
                        <span key="key" className="flex items-center gap-1">
                            <span className="font-mono text-sm text-foreground">{row.key}</span>
                            <span className="-my-1.5">
                                <CopyButton value={row.key} label="Copy API name" />
                            </span>
                        </span>,
                        description ? <span key="description">{description}</span> : null,
                    ]}
                />
            }
            actions={actions}
        />
    );
}

export function rolloutBlock(row: ModelRow): string | null {
    if (busyTearingDown(row)) {
        return row.teardown?.label ?? "A rollout is running.";
    }
    const starting = row.deployment.state === "starting" && !row.deployment.waiting;
    if (starting || row.deployment.state === "stopping") {
        const shown = deploymentShown(row);
        return `${shown.label.replace("…", "")}${shown.pool ? `${shown.joiner}${shown.pool}` : ""}: wait for it to finish.`;
    }
    return null;
}

export function trainBlock(
    row: ModelRow,
    detail: ModelDetail | undefined,
    base?: BaseModelDetail,
): string | null {
    const serveOnly = detail?.serve_only ?? row.serve_only;
    if (serveOnly) {
        return serveOnly.reason;
    }
    if (base && base.availability.state !== "available") {
        return `Waits for ${base.name} to download.`;
    }
    if (detail && !detail.dataset_version) {
        return "Add training data first: training needs examples.";
    }
    if (beingDeleted(row)) {
        return "It is being deleted.";
    }
    return null;
}

export function deployBlock(row: ModelRow, base: BaseModelDetail | undefined): string | null {
    const rollout = rolloutBlock(row);
    if (rollout) {
        return rollout;
    }
    if (row.kind === "base" && base && base.availability.state !== "available") {
        return "Its weights are not ready yet.";
    }
    if (row.health) {
        return row.health.label;
    }
    return null;
}

export function deployConfirmation(
    row: ModelRow,
    deployed: boolean,
    after: () => Promise<unknown>,
): Confirmation {
    const answeredBy =
        row.kind === "custom" && row.current_version !== null
            ? `, answered by v${row.current_version}`
            : "";
    return {
        title: deployed ? `Undeploy ${row.name}?` : `Deploy ${row.name}?`,
        description: deployed ? (
            <p>{`Apps calling ${row.key} get errors at once. Its ${row.kind === "base" ? "files" : "versions"} and keys stay.`}</p>
        ) : (
            <p>
                It becomes callable as <span className="font-mono">{row.key}</span>
                {answeredBy}.
            </p>
        ),
        confirmLabel: deployed ? `Undeploy ${row.name}` : `Deploy ${row.name}`,
        destructive: deployed,
        run: () => setDeployed(row, !deployed).then(after),
    };
}
