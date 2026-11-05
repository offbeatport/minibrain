import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Link } from "obp-ui";
import { api, succeed } from "~/api/client";
import type { DatasetVersionInfo } from "~/api/dataQueries";
import type { components } from "~/api/schema";
import { ErrorLine, Section } from "~/components/Section";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { relativeTime } from "~/lib/time";
import { itemHref } from "./catalogue";

type CheckInfo = components["schemas"]["CheckInfo"];
type CheckName = NonNullable<components["schemas"]["DataSettings"]["checks_off"]>[number];

const TONES: Record<CheckInfo["status"], Tone> = {
    ok: "success",
    warning: "warning",
    blocked: "destructive",
    off: "neutral",
    skipped: "neutral",
};

const ORDER: CheckInfo["status"][] = ["blocked", "warning", "skipped", "off", "ok"];

function useDismiss(dataset: string) {
    const client = useQueryClient();
    const refresh = () =>
        Promise.all([
            client.invalidateQueries({ queryKey: ["datasets"] }),
            client.invalidateQueries({ queryKey: ["model"] }),
        ]);
    const dismiss = useMutation({
        mutationFn: (check: CheckInfo) =>
            succeed(
                api.PUT("/api/datasets/{slug}/checks/{check}/dismissal", {
                    params: { path: { slug: dataset, check: check.check as CheckName } },
                    body: { signature: check.signature },
                }),
            ),
        onSuccess: refresh,
    });
    const restore = useMutation({
        mutationFn: (check: CheckInfo) =>
            succeed(
                api.DELETE("/api/datasets/{slug}/checks/{check}/dismissal", {
                    params: { path: { slug: dataset, check: check.check as CheckName } },
                }),
            ),
        onSuccess: refresh,
    });
    return { dismiss, restore };
}

function Finding({
    check,
    dataset,
    actions,
}: {
    check: CheckInfo;
    dataset: string | null;
    actions: ReturnType<typeof useDismiss> | null;
}) {
    return (
        <li className="flex flex-col gap-1 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusText tone={TONES[check.status]} className="font-medium">
                    {check.title}
                </StatusText>
                {dataset && actions && check.status === "warning" && (
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={actions.dismiss.isPending}
                        onClick={() => actions.dismiss.mutate(check)}
                    >
                        Dismiss for this dataset
                    </Button>
                )}
            </div>
            <p className="text-sm text-muted-foreground">{check.detail}</p>
            {check.examples.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-sm">
                    {check.examples.map((example) => (
                        <li key={example} className="truncate">
                            {example}
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}

export function ChecksReport({
    datasetVersion,
    dataset,
}: {
    datasetVersion: DatasetVersionInfo;
    dataset: string | null;
}) {
    const actions = useDismiss(dataset ?? "");
    const checks = [...(datasetVersion.checks ?? [])].sort(
        (left, right) => ORDER.indexOf(left.status) - ORDER.indexOf(right.status),
    );
    const open = checks.filter((check) => check.status !== "ok" && !check.dismissed);
    const dismissed = checks.filter((check) => check.dismissed);
    const passed = checks.filter((check) => check.status === "ok");
    if (checks.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                This version was saved before checks ran. The next one carries a report.
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-3">
            {open.length > 0 && (
                <ul className="flex flex-col divide-y rounded-lg border">
                    {open.map((check) => (
                        <Finding
                            key={check.check}
                            check={check}
                            dataset={dataset}
                            actions={dataset ? actions : null}
                        />
                    ))}
                </ul>
            )}
            {passed.length > 0 && (
                <p className="text-sm">
                    <StatusText tone="success">Passed</StatusText>
                    <span className="ml-2 text-muted-foreground">
                        {passed.map((check) => check.title).join(" · ")}
                    </span>
                </p>
            )}
            {dismissed.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="text-muted-foreground">Dismissed for this dataset:</span>
                    {dismissed.map((check) => (
                        <span key={check.check} className="inline-flex items-center gap-1">
                            <span>{check.title}</span>
                            <Button
                                variant="link"
                                className="h-auto px-0"
                                disabled={actions.restore.isPending}
                                onClick={() => actions.restore.mutate(check)}
                            >
                                Show again
                            </Button>
                        </span>
                    ))}
                </div>
            )}
            <ErrorLine error={actions.dismiss.error ?? actions.restore.error} />
        </div>
    );
}

export function ChecksSection({
    datasetVersion,
    dataset,
}: {
    datasetVersion: DatasetVersionInfo | null | undefined;
    dataset: string;
}) {
    if (!datasetVersion) {
        return null;
    }
    return (
        <Section
            title="Checks"
            caption={`On version ${datasetVersion.number ?? "–"}, saved ${relativeTime(datasetVersion.taken_at ?? datasetVersion.created_at)}. Warnings do not block training; an empty dataset or a single label stops a version from being saved. Turn checks on or off under Settings, Data.`}
        >
            <ChecksReport datasetVersion={datasetVersion} dataset={dataset} />
        </Section>
    );
}

export function ModelChecks({
    datasetVersion,
}: { datasetVersion: DatasetVersionInfo | null | undefined }) {
    const all = datasetVersion?.checks ?? [];
    if (!datasetVersion || all.length === 0) {
        return null;
    }
    const open = all.filter(
        (check) => check.status !== "ok" && check.status !== "off" && !check.dismissed,
    );
    return (
        <div className="mb-4 flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
                {open.length === 0
                    ? `Checks on version ${datasetVersion.number ?? "–"} passed.`
                    : `Checks on version ${datasetVersion.number ?? "–"} found ${open.length === 1 ? "one thing" : `${open.length} things`} to look at. Training still runs.`}
                {datasetVersion.dataset && (
                    <>
                        {" "}
                        <Link
                            href={itemHref({ kind: "dataset", id: datasetVersion.dataset })}
                            className="text-primary hover:underline"
                        >
                            Open the dataset
                        </Link>
                    </>
                )}
            </p>
            {open.length > 0 && (
                <ChecksReport datasetVersion={datasetVersion} dataset={datasetVersion.dataset} />
            )}
        </div>
    );
}
