import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { Fragment, type ReactElement, type ReactNode } from "react";
import type { BaseModelDetail, ModelDetail, ModelRow } from "~/api/client";
import type { Crumb } from "~/components/Breadcrumbs";
import { CopyButton } from "~/components/CopyButton";
import { HarnessConfigs } from "~/components/HarnessConfigs";
import { PublisherLogo } from "~/components/PublisherLogo";
import { StatusText, type Tone } from "~/components/models/StatusText";
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

export { Breadcrumbs as Crumbs } from "~/components/Breadcrumbs";

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

export function CompactHeader({
    icon,
    title,
    facts,
    subtitle,
    actions,
}: {
    icon?: ReactNode;
    title: ReactNode;
    facts?: Fact[];
    subtitle?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <header className="flex flex-wrap items-center gap-4 py-4">
            {icon}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
                    <h1 className="text-2xl leading-tight font-normal">{title}</h1>
                    {facts && (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
                            <Inline items={facts} />
                        </div>
                    )}
                </div>
                {subtitle && (
                    <div className="flex flex-col gap-0.5 text-muted-foreground">{subtitle}</div>
                )}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
    );
}

export function isDeployed(row: ModelRow): boolean {
    return row.deployment.state !== "not_deployed";
}

export function nextVersion(row: ModelRow): number {
    return Math.max(0, ...(row.versions ?? []).map((version) => version.number + 1));
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

type Shown = { tone: Tone; label: string; href?: string };

function deploymentShown(row: ModelRow): Shown {
    const version =
        row.kind === "custom" && row.current_version !== null ? ` v${row.current_version}` : "";
    const job = row.teardown?.jobs?.[0];
    const jobLink = job ? `/jobs/${job}` : undefined;
    switch (row.deployment.state) {
        case "running":
            return { tone: "success", label: version ? `Deployed ·${version}` : "Deployed" };
        case "starting":
            return { tone: "info", label: `Deploying${version}…` };
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

export function DeploymentStatus({ row }: { row: ModelRow }) {
    const shown = deploymentShown(row);
    const text = (
        <StatusText
            tone={shown.tone}
            className={shown.tone === "destructive" ? "text-destructive" : undefined}
        >
            {shown.label}
        </StatusText>
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
        <CompactHeader
            icon={<ModelAvatar row={row} size="lg" />}
            title={row.name}
            facts={[<DeploymentStatus key="deployment" row={row} />]}
            subtitle={
                <>
                    <span className="flex items-center gap-1">
                        <span className="font-mono text-sm text-foreground">{row.key}</span>
                        <span className="-my-1">
                            <CopyButton value={row.key} label="Copy API name" />
                        </span>
                    </span>
                    {description && <span>{description}</span>}
                </>
            }
            actions={actions}
        />
    );
}

export function rolloutBlock(row: ModelRow): string | null {
    if (busyTearingDown(row)) {
        return row.teardown?.label ?? "A rollout is running.";
    }
    if (row.deployment.state === "starting" || row.deployment.state === "stopping") {
        return `${deploymentShown(row).label.replace("…", "")}: wait for it to finish.`;
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

function Copyable({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-label">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="flex h-8 min-w-0 items-center gap-1 rounded-md border bg-muted pr-0.5 pl-3">
                <span className="flex-1 truncate font-mono text-sm">{value}</span>
                <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
            </span>
        </div>
    );
}

export function ConnectDialog({
    row,
    open,
    onOpenChange,
    keyValue = null,
}: {
    row: ModelRow;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    keyValue?: string | null;
}) {
    const baseUrl = `${window.location.origin}/v1`;
    const pinned = row.kind === "custom" ? (row.current_version ?? row.ready_version) : null;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{`Connect to ${row.name}`}</DialogTitle>
                    <DialogDescription>
                        {row.kind === "custom"
                            ? `OpenAI-compatible. ${row.key} answers with the live version; ${row.key}@N calls one version, live or not.`
                            : `OpenAI-compatible. Call it as ${row.key}.`}
                    </DialogDescription>
                </DialogHeader>
                {!isDeployed(row) && (
                    <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
                        {`${row.name} is not deployed, so these calls are refused until you deploy it.`}
                    </p>
                )}
                <div className="grid gap-field sm:grid-cols-[3fr_2fr_2fr]">
                    <Copyable label="Base URL" value={baseUrl} />
                    <Copyable label="Model" value={row.key} />
                    {pinned !== null && pinned !== undefined && (
                        <Copyable label="One version" value={`${row.key}@${pinned}`} />
                    )}
                </div>
                <HarnessConfigs baseUrl={baseUrl} model={row.key} keyValue={keyValue} />
                <DialogFooter>
                    <Button variant="outline" asChild>
                        <Link
                            href={modelPageHref(row.key, "api")}
                            onClick={() => onOpenChange(false)}
                        >
                            API keys
                        </Link>
                    </Button>
                    <Button onClick={() => onOpenChange(false)}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
