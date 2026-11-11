import { useRouter } from "@tanstack/react-router";
import { Button, Link, useToast } from "obp-ui";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { openTrain, useCan } from "./flowOverlays";
import {
    FLOW,
    type FlowModel,
    type FlowVersion,
    type NextStep,
    findVersion,
    jobHref,
    jobOfVersion,
    liveVersion,
    nextNumber,
    nextStep,
    openIntent,
    pct,
    percent,
    points,
    retryVersion,
    scoreDelta,
    setOnApi,
    timeLeft,
    trainingVersion,
} from "./modelsFlowData";

type Action =
    | { label: string; href: string; everyone?: boolean }
    | { label: string; run: () => void };

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

function trainingStatus(model: FlowModel): Status | null {
    const training = trainingVersion(model);
    if (!training) {
        return null;
    }
    return {
        tone: "info",
        text: `Training v${training.number} · ${Math.round((training.progress ?? 0) * 100)}% · ${timeLeft(training).replace(/^about /, "")} left`,
        action: { label: "View", href: jobHref(training.jobId) },
    };
}

function settledStatus(model: FlowModel): Status {
    if (model.deployed && model.live !== null) {
        return { tone: "success", text: liveText(model), action: null };
    }
    return { tone: "neutral", text: "Not deployed", action: null };
}

function useActions(model: FlowModel) {
    const router = useRouter();
    const toast = useToast();
    return {
        deploy: () => {
            setOnApi(model.slug, true);
            toast({ title: `${model.name} deployed`, tone: "success" });
        },
        makeLive: (number: number) => () =>
            openIntent({ kind: "make-live", slug: model.slug, number }),
        retry: (failed: number) => () => {
            const number = retryVersion(model.slug, failed);
            toast({ title: `v${number} is training`, tone: "success" });
            const job = jobOfVersion(model.slug, number);
            if (job) {
                router.history.push(jobHref(job));
            }
        },
    };
}

function stepStatus(
    model: FlowModel,
    step: NextStep | null,
    actions: ReturnType<typeof useActions>,
): Status {
    const failed = step?.version !== undefined ? findVersion(model, step.version) : undefined;
    switch (step?.action) {
        case "retry":
            return {
                tone: "destructive",
                text: `v${step.version} failed${/memory/i.test(failed?.error ?? "") ? ": out of memory" : ""}`,
                action: { label: step.label, run: actions.retry(step.version ?? 0) },
            };
        case "monitor":
            return {
                tone: "warning",
                text: `Errors ${percent(model.errors)} in the last 24 hours (usually ${percent(model.usualErrors)})`,
                action: { label: step.label, href: step.href, everyone: true },
            };
        case "make-live": {
            const number = step.version ?? 0;
            const version = findVersion(model, number);
            const delta = version ? scoreDelta(model, version) : null;
            return {
                tone: "info",
                text:
                    model.live !== null && delta !== null
                        ? `v${number} beats live by ${points(delta)}`
                        : version
                          ? readyText(model, version)
                          : `v${number} ready`,
                action: { label: step.label, run: actions.makeLive(number) },
            };
        }
        case "add-data":
            return {
                tone: "neutral",
                text: "No data yet",
                action: { label: "Add data", href: `${FLOW}/data?for=${model.slug}` },
            };
        case "watch":
            return trainingStatus(model) ?? settledStatus(model);
        case "deploy":
            return {
                tone: "neutral",
                text: "Not deployed",
                action: { label: "Deploy", run: actions.deploy },
            };
        case "train":
            if (step.rows) {
                return {
                    tone: "neutral",
                    text: `${step.rows} reviewed feedback rows`,
                    action: {
                        label: `Train v${nextNumber(model)}`,
                        run: () => openTrain(model.slug),
                    },
                };
            }
            if (!model.versions.some((version) => version.status === "ready")) {
                return {
                    tone: "neutral",
                    text: "No version yet",
                    action: {
                        label: `Train v${nextNumber(model)}`,
                        run: () => openTrain(model.slug),
                    },
                };
            }
            return trainingStatus(model) ?? settledStatus(model);
        default:
            return trainingStatus(model) ?? settledStatus(model);
    }
}

function baseStatus(model: FlowModel, deploy: () => void): Status {
    const live = model.variants.filter((item) => item.live).length;
    if (live > 0) {
        return {
            tone: "success",
            text: `Live: ${live} of ${model.variants.length} variants · ${replicasText(model.replicas.length)}`,
            action: null,
        };
    }
    return { tone: "neutral", text: "Not deployed", action: { label: "Deploy", run: deploy } };
}

function useStatus(model: FlowModel): Status {
    const builder = useCan("builder");
    const actions = useActions(model);
    const status =
        model.kind === "base"
            ? baseStatus(model, actions.deploy)
            : stepStatus(model, nextStep(model), actions);
    const everyone = status.action !== null && "href" in status.action && status.action.everyone;
    return builder || everyone ? status : { ...status, action: null };
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
