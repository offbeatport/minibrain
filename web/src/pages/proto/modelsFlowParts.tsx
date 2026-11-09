import { ChevronRight } from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
    useToast,
} from "obp-ui";
import { Fragment } from "react";
import { PublisherLogo } from "~/components/PublisherLogo";
import { StatusText } from "~/components/models/StatusText";
import { AvatarTile, choiceFor } from "./avatarDicebear";
import {
    type FlowModel,
    type FlowVersion,
    type VersionState,
    deployVersion,
    jobHref,
    liveVersion,
    points,
    versionState,
} from "./modelsFlowData";

export function ModelAvatar({ model, size = "md" }: { model: FlowModel; size?: "md" | "lg" }) {
    if (model.kind === "base") {
        return <PublisherLogo publisher={model.publisher} name={model.name} size={size} />;
    }
    return (
        <AvatarTile
            choice={model.avatar ?? choiceFor("initials", model.name)}
            name={model.name}
            size={size}
        />
    );
}

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
    return (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
            {items.map((item, index) => (
                <Fragment key={item.label}>
                    {index > 0 && (
                        <ChevronRight aria-hidden="true" className="size-3.5 text-faint" />
                    )}
                    {item.href ? (
                        <Link
                            href={item.href}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                        >
                            {item.label}
                        </Link>
                    ) : (
                        <span aria-current="page">{item.label}</span>
                    )}
                </Fragment>
            ))}
        </nav>
    );
}

export function Delta({ value, suffix }: { value: number | null; suffix?: string }) {
    if (value === null) {
        return null;
    }
    const tone =
        value > 0.0005
            ? "text-success"
            : value < -0.0005
              ? "text-destructive"
              : "text-muted-foreground";
    return (
        <span className={`tabular-nums ${tone}`}>
            {points(value)}
            {suffix && <span className="text-muted-foreground">{` ${suffix}`}</span>}
        </span>
    );
}

export function VersionStatus({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const state = versionState(model, version);
    if (version.status === "training") {
        const share = Math.round((version.progress ?? 0) * 100);
        return (
            <span className="flex items-center gap-2">
                <StatusText tone="info">
                    Training <span className="tabular-nums">{`· ${share}%`}</span>
                </StatusText>
                <Link
                    href={jobHref(version.jobId)}
                    className="relative z-10 whitespace-nowrap text-sm text-muted-foreground tabular-nums hover:text-foreground hover:underline"
                >
                    {`Job #${version.jobId}`}
                </Link>
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${DOTS[state.tone]}`} />
            {state.label}
        </span>
    );
}

const DOTS: Record<VersionState["tone"], string> = {
    success: "bg-success",
    approval: "bg-approval",
    warning: "bg-warning",
    destructive: "bg-destructive",
    info: "bg-info",
    neutral: "bg-faint",
};

export function StateBadge({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const state = versionState(model, version);
    return <Badge variant={state.tone}>{state.label}</Badge>;
}

export type DeployIntent = { model: FlowModel; version: FlowVersion } | null;

export function deployLabel(model: FlowModel, version: FlowVersion): string | null {
    const live = liveVersion(model);
    if (version.status !== "ready" || live?.number === version.number) {
        return null;
    }
    return live && version.number < live.number ? "Roll back to this" : `Deploy v${version.number}`;
}

export function deployBlocked(version: FlowVersion): string | null {
    if (version.passed === false) {
        return "It did not pass the promotion rule.";
    }
    return null;
}

export function DeployDialog({
    intent,
    onOpenChange,
}: {
    intent: DeployIntent;
    onOpenChange: (open: boolean) => void;
}) {
    const toast = useToast();
    if (!intent) {
        return null;
    }
    const { model, version } = intent;
    const live = liveVersion(model);
    const rollback = live !== undefined && version.number < live.number;
    const confirm = () => {
        deployVersion(model.slug, version.number);
        onOpenChange(false);
        toast({
            title: `v${version.number} of ${model.name} is live`,
            description: live ? `v${live.number} stays ready to roll back to.` : undefined,
            tone: "success",
        });
    };
    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {rollback
                            ? `Roll ${model.name} back to v${version.number}?`
                            : `Deploy v${version.number} of ${model.name}?`}
                    </DialogTitle>
                    <DialogDescription>
                        {`Requests to ${model.slug} are answered by v${version.number} from now on.`}
                        {live && ` v${live.number} stays ready, so you can roll back at any time.`}
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <Button onClick={confirm}>
                        {rollback ? `Roll back to v${version.number}` : `Deploy v${version.number}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
