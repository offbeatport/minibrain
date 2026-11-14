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
import { useState } from "react";
import type { ModelRow, VersionInfo } from "~/api/client";
import { api, unwrap } from "~/api/client";
import { usePlacement } from "~/api/queries";
import { FormRow, FormRows } from "~/components/FormRows";
import { type PickOption, PickSelect } from "~/components/PickSelect";
import { ErrorLine } from "~/components/Section";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import { ModelAvatar, isDeployed } from "./header";
import { PoolRow, ReplicasRow, initialPool, resolvedPool, startingReplicas } from "./poolPicker";

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
        return "Only a ready version can be deployed.";
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

export function deployable(versions: VersionInfo[]): VersionInfo[] {
    return versions
        .filter((version) => version.status === "ready")
        .sort((left, right) => right.number - left.number);
}

function versionOptions(versions: VersionInfo[]): PickOption[] {
    return versions.map((version) => ({
        value: String(version.number),
        label: versionLabel(version),
        meta:
            [
                version.score === null ? null : percent(version.score),
                version.current ? "deployed" : null,
            ]
                .filter(Boolean)
                .join(" · ") || undefined,
    }));
}

export function ModelCard({ row }: { row: ModelRow }) {
    return (
        <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
            <ModelAvatar row={row} size="md" />
            <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{row.name}</span>
                <span className="truncate font-mono text-sm text-muted-foreground">{row.key}</span>
            </span>
        </div>
    );
}

export function DeployVersionDialog({
    row,
    versions,
    number,
    onOpenChange,
    pick = false,
}: {
    row: ModelRow;
    versions: VersionInfo[];
    number: number | null;
    onOpenChange: (open: boolean) => void;
    pick?: boolean;
}) {
    const client = useQueryClient();
    const toast = useToast();
    const can = useCan();
    const open = number !== null && can.build;
    const placement = usePlacement(row.key, open);
    const [picked, setPicked] = useState<number | null>(null);
    const [pool, setPool] = useState<string | null>(null);
    const [replicas, setReplicas] = useState<number | null>(null);
    const chosen = picked ?? number;
    const poolValue = pool ?? initialPool(placement.data);
    const target = resolvedPool(placement.data, poolValue);
    const replicaValue =
        replicas ?? startingReplicas(placement.data, target, row.deployment.replicas);
    const version = versions.find((item) => item.number === chosen);
    const deployed = isDeployed(row);
    const live = deployed ? liveOf(versions) : undefined;
    const moving = Boolean(
        deployed && target && placement.data?.pool && target !== placement.data.pool,
    );
    const rescaling = deployed && !moving && replicaValue !== (row.deployment.replicas ?? 1);
    const already =
        Boolean(version && live && live.number === version.number) && !moving && !rescaling;
    const close = (next: boolean) => {
        if (!next) {
            setPicked(null);
            setPool(null);
            setReplicas(null);
        }
        onOpenChange(next);
    };
    const choosePool = (next: string) => {
        setPool(next);
        setReplicas(null);
    };
    const promote = useMutation({
        mutationFn: (target: number) =>
            unwrap(
                api.POST("/api/models/{name}/versions/{number}/promote", {
                    params: { path: { name: row.key, number: target } },
                    body: { pool: poolValue, replicas: replicaValue },
                }),
            ),
        onSuccess: async (_, number) => {
            await client.invalidateQueries();
            close(false);
            toast({
                title: `v${number} of ${row.name} is deployed${target ? ` on ${target}` : ""}`,
                description:
                    live && live.number !== number
                        ? `v${live.number} stays callable as ${row.key}@${live.number}.`
                        : undefined,
                tone: "success",
            });
        },
    });
    const blocked = version && !already ? liveBlock(row, version) : null;
    const replacing = version && live && live.number !== version.number;
    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {pick || !version ? "Deploy" : `Deploy v${version.number}?`}
                    </DialogTitle>
                    <ModelCard row={row} />
                    {version && !already && (
                        <DialogDescription>
                            {[
                                direction(version, live),
                                `Requests to ${row.key} are answered by v${version.number} from now on.`,
                                replacing
                                    ? `v${live.number} stays callable as ${row.key}@${live.number}, and you can deploy it again at any time.`
                                    : "",
                            ]
                                .filter(Boolean)
                                .join(" ")}
                        </DialogDescription>
                    )}
                </DialogHeader>
                <FormRows labels="narrow">
                    {pick && version && (
                        <FormRow id="deploy-version" label="Version">
                            <PickSelect
                                id="deploy-version"
                                compact
                                value={String(version.number)}
                                options={versionOptions(deployable(versions))}
                                onChange={(next) => setPicked(Number(next))}
                            />
                        </FormRow>
                    )}
                    <PoolRow placement={placement.data} value={poolValue} onChange={choosePool} />
                    <ReplicasRow
                        placement={placement.data}
                        target={target}
                        value={replicaValue}
                        onChange={setReplicas}
                    />
                </FormRows>
                {already && version && (
                    <p className="rounded-md border bg-muted px-3 py-2">
                        {`v${version.number} is deployed and answers ${row.key}.`}
                    </p>
                )}
                {blocked && (
                    <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
                        {blocked}
                    </p>
                )}
                <ErrorLine error={promote.error ?? placement.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => close(false)}>
                        Cancel
                    </Button>
                    <Button
                        disabled={
                            !version || !target || already || Boolean(blocked) || promote.isPending
                        }
                        onClick={() => version && promote.mutate(version.number)}
                    >
                        {version ? `Deploy v${version.number}` : "Deploy"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
