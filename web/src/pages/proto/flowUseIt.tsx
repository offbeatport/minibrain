import { Button, Link, useToast } from "obp-ui";
import { CopyButton } from "~/components/CopyButton";
import { useCan } from "./flowOverlays";
import {
    type FlowModel,
    makeLive,
    modelHref,
    newestFirst,
    playgroundHref,
    setOnApi,
    shortAgo,
    useFlowState,
} from "./modelsFlowData";
import { openConnect } from "./modelsFlowParts";

function apiNameOf(model: FlowModel): string {
    if (model.kind !== "base") {
        return model.slug;
    }
    return (model.variants.find((item) => item.live) ?? model.variants[0])?.apiName ?? model.slug;
}

function KeysLine({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const toast = useToast();
    const keys = state.keys[model.slug] ?? [];
    if (!model.deployed) {
        const ready = newestFirst(model).find((version) => version.status === "ready");
        const deployable = model.kind === "base" || model.live !== null || ready;
        if (!deployable) {
            return <p className="text-sm text-muted-foreground">Not deployed</p>;
        }
        return (
            <p className="text-sm text-muted-foreground">
                {"Not deployed · "}
                <Button
                    variant="link"
                    className="h-auto p-0 text-sm"
                    onClick={() => {
                        if (model.live === null && ready) {
                            makeLive(model.slug, ready.number);
                        } else {
                            setOnApi(model.slug, true);
                        }
                        toast({ title: `${model.name} deployed`, tone: "success" });
                    }}
                >
                    Deploy
                </Button>
            </p>
        );
    }
    if (keys.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                {"No API keys yet · "}
                <Link
                    href={`${modelHref(model.slug, "keys")}?new=1`}
                    className="text-primary hover:underline"
                >
                    Create key
                </Link>
            </p>
        );
    }
    const used = keys.map((key) => key.lastUsed).filter((value): value is number => value !== null);
    const last = used.length > 0 ? shortAgo({ hoursAgo: Math.min(...used) }) : null;
    return (
        <p className="text-sm text-muted-foreground tabular-nums">
            {`${keys.length} `}
            <Link href={modelHref(model.slug, "keys")} className="text-primary hover:underline">
                {keys.length === 1 ? "API key" : "API keys"}
            </Link>
            {last ? ` · last call ${last}` : " · no calls yet"}
        </p>
    );
}

export function UseIt({ model }: { model: FlowModel }) {
    const builder = useCan("builder");
    const name = apiNameOf(model);
    const playable =
        model.kind === "base"
            ? model.variants.length > 0
            : model.versions.some((version) => version.status === "ready");
    return (
        <section
            aria-labelledby="use-it-title"
            className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-panel"
        >
            <h2 id="use-it-title" className="text-base leading-tight font-semibold">
                Use it
            </h2>
            {builder && (
                <div className="flex items-center gap-2 rounded-md border bg-muted pl-3">
                    <span className="flex-1 truncate font-mono text-sm" title={name}>
                        {name}
                    </span>
                    <CopyButton value={name} label="Copy API name" />
                </div>
            )}
            <div className="flex flex-wrap gap-2">
                {playable && (
                    <Button variant="outline" asChild>
                        <Link href={playgroundHref(model.slug)}>Open in Playground</Link>
                    </Button>
                )}
                <Button variant="outline" onClick={() => openConnect(model.slug)}>
                    Connect
                </Button>
            </div>
            {builder && <KeysLine model={model} />}
        </section>
    );
}
