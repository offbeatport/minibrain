import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    useToast,
} from "obp-ui";
import type { ModelRow, VersionInfo } from "~/api/client";
import { api, unwrap } from "~/api/client";
import { ErrorLine } from "~/components/Section";
import { useCan } from "~/lib/access";
import { isDeployed } from "./header";

export function points(delta: number): string {
    const value = Math.abs(delta * 100).toFixed(1);
    if (Number(value) === 0) {
        return "±0";
    }
    return `${delta > 0 ? "+" : "−"}${value}`;
}

export function liveOf(versions: VersionInfo[] | undefined): VersionInfo | undefined {
    return versions?.find((version) => version.current);
}

export function isBaseline(version: Pick<VersionInfo, "kind" | "number">): boolean {
    return version.kind === "prompt" && version.number === 0;
}

export function versionLabel(version: Pick<VersionInfo, "kind" | "number">): string {
    if (version.kind === "prompt") {
        return version.number === 0 ? "v0 · Baseline" : `v${version.number} · Prompt`;
    }
    return `v${version.number}`;
}

export function liveBlock(row: ModelRow, version: VersionInfo): string | null {
    if (version.status !== "ready") {
        return "Only a ready version can go live.";
    }
    if (version.base_refusal) {
        return version.base_refusal;
    }
    if (!version.live_at && version.promotion && !version.promotion.passed) {
        return ruleReason(version);
    }
    if (row.teardown) {
        return row.teardown.label;
    }
    return null;
}

export function ruleReason(version: VersionInfo): string {
    const failed = version.promotion?.checks.filter((check) => !check.passed) ?? [];
    return failed.length > 0
        ? `Below the promotion rule: ${failed.map((check) => check.detail).join("; ")}.`
        : "Below the promotion rule.";
}

export function canGoLive(row: ModelRow, version: VersionInfo): boolean {
    const live = row.current_version === version.number && isDeployed(row);
    return !live && version.status === "ready";
}

function direction(version: VersionInfo, live: VersionInfo | undefined): string {
    if (!live || live.number === version.number) {
        return "";
    }
    const scored = live.score !== null && version.score !== null;
    const delta = scored ? (version.score ?? 0) - (live.score ?? 0) : null;
    if (version.number < live.number) {
        return `v${version.number} replaces live v${live.number}${delta === null ? "" : ` (${points(delta)})`}.`;
    }
    return delta === null
        ? `v${version.number} replaces live v${live.number}.`
        : `v${version.number} scores ${points(delta)} over live v${live.number}.`;
}

export function MakeLiveDialog({
    row,
    versions,
    number,
    onOpenChange,
}: {
    row: ModelRow;
    versions: VersionInfo[];
    number: number | null;
    onOpenChange: (open: boolean) => void;
}) {
    const client = useQueryClient();
    const toast = useToast();
    const can = useCan();
    const version = versions.find((item) => item.number === number);
    const live = isDeployed(row) ? liveOf(versions) : undefined;
    const deployed = isDeployed(row);
    const promote = useMutation({
        mutationFn: (target: number) =>
            unwrap(
                api.POST("/api/models/{slug}/versions/{number}/promote", {
                    params: { path: { slug: row.key, number: target } },
                }),
            ),
        onSuccess: async (_, target) => {
            await client.invalidateQueries();
            onOpenChange(false);
            toast({
                title: `v${target} of ${row.name} is live`,
                description: live
                    ? `v${live.number} stays callable as ${row.key}@${live.number}.`
                    : undefined,
                tone: "success",
            });
        },
    });
    const blocked = version ? liveBlock(row, version) : null;
    return (
        <Dialog open={Boolean(version) && can.build} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                {version && (
                    <>
                        <DialogHeader>
                            <DialogTitle>{`Make v${version.number} of ${row.name} live?`}</DialogTitle>
                            <DialogDescription>
                                {[
                                    direction(version, live),
                                    `Requests to ${row.key} are answered by v${version.number} from now on.`,
                                    live
                                        ? `v${live.number} stays callable as ${row.key}@${live.number}, and you can make it live again at any time.`
                                        : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                            </DialogDescription>
                        </DialogHeader>
                        {blocked && (
                            <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
                                {blocked}
                            </p>
                        )}
                        {!deployed && !blocked && (
                            <p className="rounded-md border bg-muted px-3 py-2">
                                {`${row.name} is not deployed: making v${version.number} live also deploys it, so ${row.key} starts answering.`}
                            </p>
                        )}
                        <ErrorLine error={promote.error} />
                        <DialogFooter>
                            <Button variant="outline" onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button
                                disabled={Boolean(blocked) || promote.isPending}
                                onClick={() => promote.mutate(version.number)}
                            >
                                {`Make v${version.number} live`}
                            </Button>
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
