import { Button, Link, useToast } from "obp-ui";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { openTrain, useCan } from "./flowOverlays";
import {
    FLOW,
    type FlowModel,
    type FlowVersion,
    findVersion,
    jobHref,
    liveVersion,
    makeLive,
    modelHref,
    newestFirst,
    pct,
    points,
    setOnApi,
    timeLeft,
    trainingVersion,
} from "./modelsFlowData";

type Action = { label: string; href: string } | { label: string; run: () => void };

type Status = { tone: Tone; text: string; action: Action | null };

function replicasText(count: number): string {
    return `${count} ${count === 1 ? "replica" : "replicas"}`;
}

function readyText(model: FlowModel, version: FlowVersion): string {
    const score = pct(version.scores?.[0]);
    const zero = findVersion(model, 0);
    if (version.kind === "prompt" || !zero?.scores || !version.scores) {
        return `v${version.number} ready · ${score}`;
    }
    return `v${version.number} ready · ${score} (${points(version.scores[0] - zero.scores[0])} over baseline)`;
}

function liveText(model: FlowModel): string {
    const live = liveVersion(model);
    const split = model.canary
        ? `v${model.live} ${100 - model.canary.share}% · v${model.canary.version} ${model.canary.share}%`
        : `v${live?.number ?? model.live}`;
    return `Live: ${split} · ${replicasText(model.replicas.length)}`;
}

function useStatus(model: FlowModel): Status {
    const toast = useToast();
    const builder = useCan("builder");
    const act = (action: Action): Action | null => (builder ? action : null);
    const deploy = (number?: number) => () => {
        if (number !== undefined && model.live === null) {
            makeLive(model.slug, number);
        } else {
            setOnApi(model.slug, true);
        }
        toast({ title: `${model.name} deployed`, tone: "success" });
    };
    if (model.kind === "base") {
        const live = model.variants.filter((item) => item.live).length;
        return live > 0
            ? {
                  tone: "success",
                  text: `Live: ${live} of ${model.variants.length} variants · ${replicasText(model.replicas.length)}`,
                  action: { label: "Variants", href: modelHref(model.slug, "variants") },
              }
            : {
                  tone: "neutral",
                  text: "Not deployed",
                  action: act({ label: "Deploy", run: deploy() }),
              };
    }
    const training = trainingVersion(model);
    if (training) {
        return {
            tone: "info",
            text: `Training v${training.number} · ${Math.round((training.progress ?? 0) * 100)}% · ${timeLeft(training).replace(/^about /, "")} left`,
            action: { label: "View", href: jobHref(training.jobId) },
        };
    }
    if (!model.dataset) {
        return {
            tone: "neutral",
            text: "No data yet",
            action: act({ label: "Add data", href: `${FLOW}/data?for=${model.slug}` }),
        };
    }
    const ready = newestFirst(model).find((version) => version.status === "ready");
    if (ready && (!model.deployed || model.live === null)) {
        const number = model.live ?? ready.number;
        const shown = findVersion(model, number) ?? ready;
        return {
            tone: "neutral",
            text: readyText(model, shown),
            action: act({ label: "Deploy", run: deploy(number) }),
        };
    }
    if (model.deployed && model.live !== null) {
        return {
            tone: "success",
            text: liveText(model),
            action: { label: "Monitoring", href: modelHref(model.slug, "monitoring") },
        };
    }
    return {
        tone: "neutral",
        text: "No version yet",
        action: act({ label: "Train", run: () => openTrain(model.slug) }),
    };
}

export function StatusLine({ model }: { model: FlowModel }) {
    const status = useStatus(model);
    const action = status.action;
    return (
        <p className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
            <StatusText tone={status.tone} className="min-w-0 truncate">
                {status.text}
            </StatusText>
            {action && (
                <>
                    <span aria-hidden="true" className="text-faint">
                        ·
                    </span>
                    {"href" in action ? (
                        <Link href={action.href} className="text-primary hover:underline">
                            {action.label}
                        </Link>
                    ) : (
                        <Button variant="link" className="h-auto p-0" onClick={action.run}>
                            {action.label}
                        </Button>
                    )}
                </>
            )}
        </p>
    );
}
