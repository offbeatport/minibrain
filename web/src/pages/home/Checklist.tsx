import { ArrowRight, Check, X } from "lucide-react";
import { Button, Link, cn } from "obp-ui";
import { useState } from "react";
import type { ModelRow } from "~/api/client";
import { useDatasets } from "~/api/queries";
import { Section } from "~/components/Section";
import { type ModelTab, modelPageHref } from "~/lib/modelLinks";

const DISMISSED_KEY = "minibrain.home.checklist.dismissed";

type Step = {
    id: string;
    title: string;
    detail: string;
    action: string;
    href: string;
    done: boolean;
};

function readDismissed(): boolean {
    try {
        return window.localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
        return false;
    }
}

function writeDismissed() {
    try {
        window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
        return;
    }
}

function newest(models: ModelRow[]): ModelRow | undefined {
    return [...models].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

function trained(model: ModelRow): boolean {
    return (model.versions ?? []).some(
        (version) => version.kind === "lora" && version.status === "ready",
    );
}

function scored(model: ModelRow): boolean {
    return (model.versions ?? []).some(
        (version) =>
            version.kind === "lora" && version.score !== null && version.score !== undefined,
    );
}

function stepsOf(models: ModelRow[], datasets: number): Step[] {
    const latest = newest(models);
    const modelHref = (tab: ModelTab) => (latest ? modelPageHref(latest.key, tab) : "/models/new");
    return [
        {
            id: "data",
            title: "Add data",
            detail: "Upload a CSV or JSONL, connect a database, or add the demo data.",
            action: "Add data",
            href: "/data?add=1",
            done: datasets > 0,
        },
        {
            id: "model",
            title: "Add a model",
            detail: "Pick a base model and a dataset. Version 0 is scored at once.",
            action: "Add model",
            href: "/models/new",
            done: models.length > 0,
        },
        {
            id: "train",
            title: "Train",
            detail: "Fine-tune a version on the dataset, scored on the same held-out rows.",
            action: "Train",
            href: latest ? `${modelPageHref(latest.key)}/train` : "/models/new",
            done: models.some(trained),
        },
        {
            id: "evaluate",
            title: "Evaluate",
            detail: "Compare the trained version with version 0 and see where it fails.",
            action: "Open Evaluation",
            href: modelHref("evaluation"),
            done: models.some(scored),
        },
        {
            id: "deploy",
            title: "Deploy",
            detail: "Make the version that passes the promotion rule live.",
            action: "Deploy",
            href: modelHref("overview"),
            done: models.some((model) => model.current_version !== null),
        },
        {
            id: "connect",
            title: "Connect an app",
            detail: "Create an API key; apps call /v1 with the model's API name.",
            action: "Create a key",
            href: modelHref("api"),
            done: models.some((model) => (model.key_count ?? 0) > 0),
        },
    ];
}

function StepRow({ step, next }: { step: Step; next: boolean }) {
    return (
        <li className="flex items-center gap-3 px-panel py-3">
            <span
                aria-hidden="true"
                className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border border-input",
                    step.done && "border-success bg-success text-success-foreground",
                    !step.done && next && "border-primary",
                )}
            >
                {step.done && <Check className="size-3.5" strokeWidth={3} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
                <span className={cn("font-medium", step.done && "text-muted-foreground")}>
                    {step.title}
                    <span className="sr-only">{step.done ? ", done" : ", not done"}</span>
                </span>
                {!step.done && (
                    <span className="truncate text-sm text-muted-foreground">{step.detail}</span>
                )}
            </div>
            {!step.done && (
                <Button asChild variant={next ? "default" : "outline"}>
                    <Link href={step.href}>
                        {step.action}
                        {next && <ArrowRight aria-hidden="true" />}
                    </Link>
                </Button>
            )}
        </li>
    );
}

export function Checklist({ models }: { models: ModelRow[] }) {
    const datasets = useDatasets();
    const [dismissed, setDismissed] = useState(readDismissed);
    if (dismissed || !datasets.data) {
        return null;
    }
    const steps = stepsOf(models, datasets.data.length);
    const done = steps.filter((step) => step.done).length;
    if (done === steps.length) {
        return null;
    }
    const next = steps.find((step) => !step.done);
    const dismiss = () => {
        writeDismissed();
        setDismissed(true);
    };
    return (
        <Section
            title="Get started"
            caption={`${done} of ${steps.length} done. From your data to an app calling your own model.`}
            actions={
                <Button variant="ghost" onClick={dismiss}>
                    <X aria-hidden="true" />
                    Dismiss
                </Button>
            }
            flush
        >
            <ol className="divide-y">
                {steps.map((step) => (
                    <StepRow key={step.id} step={step} next={step === next} />
                ))}
            </ol>
        </Section>
    );
}
