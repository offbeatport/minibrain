import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    useToast,
} from "obp-ui";
import { useState } from "react";
import type { ModelRow, VersionInfo } from "~/api/client";
import { api, unwrap } from "~/api/client";
import { ErrorLine } from "~/components/Section";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import { ModelAvatar, isDeployed } from "./header";

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

function VersionPicker({
    versions,
    value,
    onChange,
}: {
    versions: VersionInfo[];
    value: number;
    onChange: (number: number) => void;
}) {
    return (
        <Field id="deploy-version" label="Version">
            <Select value={String(value)} onValueChange={(next) => onChange(Number(next ?? value))}>
                <SelectTrigger id="deploy-version" className="w-full max-w-64">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {versions.map((version) => {
                        const text = [
                            versionLabel(version),
                            version.score === null ? null : percent(version.score),
                            version.current ? "deployed" : null,
                        ]
                            .filter(Boolean)
                            .join(" · ");
                        return (
                            <SelectItem key={version.number} value={String(version.number)}>
                                {text}
                            </SelectItem>
                        );
                    })}
                </SelectContent>
            </Select>
        </Field>
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
    const [picked, setPicked] = useState<number | null>(null);
    const chosen = picked ?? number;
    const version = versions.find((item) => item.number === chosen);
    const deployed = isDeployed(row);
    const live = deployed ? liveOf(versions) : undefined;
    const already = Boolean(version && live && live.number === version.number);
    const close = (open: boolean) => {
        if (!open) {
            setPicked(null);
        }
        onOpenChange(open);
    };
    const promote = useMutation({
        mutationFn: (target: number) =>
            unwrap(
                api.POST("/api/models/{name}/versions/{number}/promote", {
                    params: { path: { name: row.key, number: target } },
                }),
            ),
        onSuccess: async (_, target) => {
            await client.invalidateQueries();
            close(false);
            toast({
                title: `v${target} of ${row.name} is deployed`,
                description: live
                    ? `v${live.number} stays callable as ${row.key}@${live.number}.`
                    : undefined,
                tone: "success",
            });
        },
    });
    const blocked = version && !already ? liveBlock(row, version) : null;
    return (
        <Dialog open={number !== null && can.build} onOpenChange={close}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {pick || !version ? "Deploy" : `Deploy v${version.number}?`}
                    </DialogTitle>
                    <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
                        <ModelAvatar row={row} size="md" />
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate font-medium">{row.name}</span>
                            <span className="truncate font-mono text-sm text-muted-foreground">
                                {row.key}
                            </span>
                        </span>
                    </div>
                    {version && !already && (
                        <DialogDescription>
                            {[
                                direction(version, live),
                                `Requests to ${row.key} are answered by v${version.number} from now on.`,
                                live
                                    ? `v${live.number} stays callable as ${row.key}@${live.number}, and you can deploy it again at any time.`
                                    : "",
                            ]
                                .filter(Boolean)
                                .join(" ")}
                        </DialogDescription>
                    )}
                </DialogHeader>
                {pick && version && (
                    <VersionPicker
                        versions={deployable(versions)}
                        value={version.number}
                        onChange={setPicked}
                    />
                )}
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
                <ErrorLine error={promote.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => close(false)}>
                        Cancel
                    </Button>
                    <Button
                        disabled={!version || already || Boolean(blocked) || promote.isPending}
                        onClick={() => version && promote.mutate(version.number)}
                    >
                        {version ? `Deploy v${version.number}` : "Deploy"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
