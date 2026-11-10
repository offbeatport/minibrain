import { ChevronRight } from "lucide-react";
import {
    Badge,
    Button,
    CodeTabs,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    useToast,
} from "obp-ui";
import { Fragment, type ReactNode } from "react";
import { CopyButton } from "~/components/CopyButton";
import { PublisherLogo } from "~/components/PublisherLogo";
import { StatusText } from "~/components/models/StatusText";
import { AvatarTile, choiceFor } from "./avatarDicebear";
import { useCan } from "./flowOverlays";
import {
    BASELINE_HINT,
    type FlowModel,
    type FlowVersion,
    type VersionState,
    findVersion,
    jobHref,
    liveVersion,
    makeLive,
    markVisited,
    modelHref,
    newestFirst,
    openIntent,
    points,
    ruleReason,
    scoreNote,
    useFlowState,
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

export function VersionName({ version }: { version: Pick<FlowVersion, "number" | "kind"> }) {
    if (version.kind !== "prompt") {
        return <span className="tabular-nums">{`v${version.number}`}</span>;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="relative z-10 cursor-help tabular-nums" tabIndex={-1}>
                    {`v${version.number} · Baseline`}
                </span>
            </TooltipTrigger>
            <TooltipContent>{BASELINE_HINT}</TooltipContent>
        </Tooltip>
    );
}

export function VersionStatus({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const state = versionState(model, version);
    if (version.status === "training") {
        const share = Math.round((version.progress ?? 0) * 100);
        return (
            <span className="flex items-center gap-2">
                <StatusText tone="info">
                    <span className="tabular-nums">{`Training · ${share}%`}</span>
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
            <span className="tabular-nums">{state.label}</span>
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

export function ScoreBadge({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const note = scoreNote(model, version);
    if (!note) {
        return null;
    }
    if (note.kind === "beats") {
        return <Badge variant="success">{`beats live ${points(note.delta)}`}</Badge>;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Badge variant="neutral" className="relative z-10 cursor-help" tabIndex={0}>
                    below rule
                </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{note.reason}</TooltipContent>
        </Tooltip>
    );
}

export function makeLiveLabel(model: FlowModel, version: FlowVersion): string | null {
    if (version.status !== "ready" || (model.live === version.number && !model.canary)) {
        return null;
    }
    if (model.live === version.number) {
        return "End canary";
    }
    return model.live !== null && version.number < model.live ? "Roll back" : "Make live";
}

export function MakeLiveButton({
    model,
    version,
    variant,
    label,
}: {
    model: FlowModel;
    version: FlowVersion;
    variant?: "default" | "secondary" | "outline";
    label?: string;
}) {
    const text = makeLiveLabel(model, version);
    const can = useCan("builder");
    if (!text || !can) {
        return null;
    }
    const quiet = text !== "Make live" || version.passed === false;
    return (
        <Button
            variant={variant ?? (quiet ? "outline" : "default")}
            onClick={() =>
                openIntent({
                    kind: "make-live",
                    slug: model.slug,
                    number: version.number,
                })
            }
        >
            {label ?? text}
        </Button>
    );
}

function Callout({ tone, children }: { tone: "warning" | "info"; children: ReactNode }) {
    return (
        <div
            className={
                tone === "warning"
                    ? "rounded-md border border-warning/40 bg-warning-soft px-3 py-2"
                    : "rounded-md border bg-muted px-3 py-2"
            }
        >
            {children}
        </div>
    );
}

function MakeLiveBody({
    model,
    version,
    source,
    onClose,
}: {
    model: FlowModel;
    version: FlowVersion;
    source?: "inbox";
    onClose: () => void;
}) {
    const toast = useToast();
    const live = liveVersion(model);
    const rollback = live !== undefined && version.number < live.number;
    const below = version.passed === false;
    const first = model.live === null && !model.deployed;
    const confirm = () => {
        makeLive(model.slug, version.number, source);
        onClose();
        toast({
            title: rollback
                ? `${model.name} rolled back to v${version.number}`
                : `v${version.number} of ${model.name} is live`,
            description: live
                ? `v${live.number} stays callable as ${model.slug}@${live.number}.`
                : undefined,
            tone: "success",
        });
    };
    return (
        <>
            <DialogHeader>
                <DialogTitle>
                    {rollback
                        ? `Roll ${model.name} back to v${version.number}?`
                        : `Make v${version.number} of ${model.name} live?`}
                </DialogTitle>
                <DialogDescription>
                    {`Requests to ${model.slug} are answered by v${version.number} from now on.`}
                    {model.canary && ` The v${model.canary.version} canary ends.`}
                    {live &&
                        ` v${live.number} stays callable as ${model.slug}@${live.number}, so you can roll back at any time.`}
                </DialogDescription>
            </DialogHeader>
            {below && (
                <Callout tone="warning">
                    <p className="font-medium">{`v${version.number} is below the promotion rule`}</p>
                    <p className="text-sm">{ruleReason(model, version)}</p>
                </Callout>
            )}
            {first && (
                <Callout tone="info">{`${model.name} is not deployed yet: making v${version.number} live also deploys it, so ${model.slug} starts answering.`}</Callout>
            )}
            {!first && !model.deployed && (
                <Callout tone="info">
                    {`${model.name} is not deployed: nothing calls it until you deploy it.`}
                </Callout>
            )}
            <DialogFooter>
                <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button onClick={confirm}>
                    {rollback
                        ? `Roll back to v${version.number}`
                        : below
                          ? "Make live anyway"
                          : `Make live v${version.number}`}
                </Button>
            </DialogFooter>
        </>
    );
}

export const API_BASE = "https://minibrain.internal/v1";

export function snippets(model: string, key: string) {
    const message = '[{"role": "user", "content": "I was charged twice"}]';
    return [
        {
            id: "curl",
            label: "curl",
            language: "bash" as const,
            code: `curl ${API_BASE}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${model}", "messages": ${message}}'`,
        },
        {
            id: "python",
            label: "Python",
            language: "python" as const,
            code: `from openai import OpenAI\n\nclient = OpenAI(base_url="${API_BASE}", api_key="${key}")\nreply = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "I was charged twice"}],\n)\nprint(reply.choices[0].message.content)`,
        },
        {
            id: "js",
            label: "JavaScript",
            language: "javascript" as const,
            code: `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${API_BASE}", apiKey: "${key}" });\nconst reply = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "I was charged twice" }],\n});\nconsole.log(reply.choices[0].message.content);`,
        },
    ];
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

function ConnectBody({ model, onClose }: { model: FlowModel; onClose: () => void }) {
    const pinned =
        model.kind === "custom"
            ? (liveVersion(model) ??
              newestFirst(model).find((version) => version.status === "ready"))
            : undefined;
    const name = model.kind === "base" ? (model.variants[0]?.apiName ?? model.slug) : model.slug;
    return (
        <>
            <DialogHeader>
                <DialogTitle>{`Connect to ${model.name}`}</DialogTitle>
                <DialogDescription>
                    {model.kind === "custom"
                        ? `OpenAI-compatible. ${model.slug} answers with the live version; ${model.slug}@N calls one version, live or not.`
                        : "OpenAI-compatible. Each deployed format has its own model name."}
                </DialogDescription>
            </DialogHeader>
            {!model.deployed && (
                <Callout tone="warning">
                    {`${model.name} is not deployed, so these calls are refused until you deploy it.`}
                </Callout>
            )}
            <div className="grid gap-field sm:grid-cols-[3fr_2fr_2fr]">
                <Copyable label="Base URL" value={API_BASE} />
                <Copyable label="Model" value={name} />
                {pinned && (
                    <Copyable label="One version" value={`${model.slug}@${pinned.number}`} />
                )}
            </div>
            <CodeTabs items={snippets(name, "$MINIBRAIN_API_KEY")} />
            <DialogFooter>
                <Button variant="outline" asChild>
                    <Link href={`${modelHref(model.slug, "keys")}?new=1`} onClick={onClose}>
                        Create an API key
                    </Link>
                </Button>
                <DialogClose asChild>
                    <Button>Done</Button>
                </DialogClose>
            </DialogFooter>
        </>
    );
}

export function IntentDialogs() {
    const state = useFlowState();
    const intent = state.intent;
    const close = () => openIntent(null);
    const model = intent ? state.models.find((item) => item.slug === intent.slug) : undefined;
    const version =
        intent?.kind === "make-live" && model ? findVersion(model, intent.number) : undefined;
    return (
        <Dialog open={Boolean(model)} onOpenChange={(open) => !open && close()}>
            <DialogContent className={intent?.kind === "connect" ? "sm:max-w-4xl" : "sm:max-w-lg"}>
                {intent?.kind === "make-live" && model && version && (
                    <MakeLiveBody
                        model={model}
                        version={version}
                        source={intent.source}
                        onClose={close}
                    />
                )}
                {intent?.kind === "connect" && model && (
                    <ConnectBody model={model} onClose={close} />
                )}
            </DialogContent>
        </Dialog>
    );
}

export function openConnect(slug: string) {
    markVisited("connect");
    openIntent({ kind: "connect", slug });
}
