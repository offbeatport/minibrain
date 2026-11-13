import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, GraduationCap, Play, Plug, Rocket, SquarePlus } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Link,
} from "obp-ui";
import { useState } from "react";
import type { BaseModelDetail, ModelDetail, ModelRow, VersionInfo } from "~/api/client";
import { keys } from "~/api/queries";
import { useCan } from "~/lib/access";
import { modelPageHref, playgroundHref, trainHref } from "~/lib/modelLinks";
import { ConfirmAction, type Confirmation, useModelsRefresh } from "../dialogs";
import {
    ConnectDialog,
    DeploymentStatus,
    Tip,
    deployBlock,
    deployConfirmation,
    isDeployed,
    trainBlock,
} from "./header";
import { DeployVersionDialog, deployable } from "./makeLive";

function startingVersion(row: ModelRow, versions: VersionInfo[]): number | null {
    const ready = deployable(versions);
    const current = ready.find((version) => version.number === row.current_version);
    if (current) {
        return current.number;
    }
    const scored = ready.filter((version) => version.score !== null);
    const best = scored.sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
    return (best ?? ready[0])?.number ?? null;
}

function BaseDeployedDialog({
    row,
    open,
    onOpenChange,
}: {
    row: ModelRow;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{`Deploy ${row.name}`}</DialogTitle>
                    <DialogDescription>
                        It answers as <span className="font-mono">{row.key}</span>.
                    </DialogDescription>
                </DialogHeader>
                <p className="rounded-md border bg-muted px-3 py-2">
                    <DeploymentStatus row={row} />
                </p>
                <DialogFooter>
                    <Button variant="outline" asChild>
                        <Link
                            href={`${modelPageHref(row.key, "settings")}#deployment`}
                            onClick={() => onOpenChange(false)}
                        >
                            Undeploy in Settings
                        </Link>
                    </Button>
                    <Button onClick={() => onOpenChange(false)}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function DeployButton({
    row,
    base,
    versions,
}: {
    row: ModelRow;
    base: BaseModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const client = useQueryClient();
    const refresh = useModelsRefresh();
    const [number, setNumber] = useState<number | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [showing, setShowing] = useState(false);
    const custom = row.kind === "custom";
    const deployed = isDeployed(row);
    const starting = custom ? startingVersion(row, versions) : null;
    const blocked = custom
        ? (deployBlock(row, base) ??
          (starting === null ? "Nothing to deploy yet: no version is ready." : null))
        : deployed
          ? null
          : deployBlock(row, base);
    const reload = async () => {
        await refresh();
        await client.invalidateQueries({ queryKey: keys.modelPage(row.key) });
    };
    const open = () => {
        if (custom) {
            setNumber(starting);
        } else if (deployed) {
            setShowing(true);
        } else {
            setConfirmation(deployConfirmation(row, false, reload));
        }
    };
    return (
        <>
            <Tip tip={blocked}>
                <Button variant="outline" disabled={Boolean(blocked)} onClick={open}>
                    <Rocket />
                    Deploy
                </Button>
            </Tip>
            {custom ? (
                <DeployVersionDialog
                    row={row}
                    versions={versions}
                    number={number}
                    pick
                    onOpenChange={(next) => !next && setNumber(null)}
                />
            ) : (
                <BaseDeployedDialog row={row} open={showing} onOpenChange={setShowing} />
            )}
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(next) => !next && setConfirmation(null)}
            />
        </>
    );
}

function UseMenu({ row }: { row: ModelRow }) {
    const router = useRouter();
    const [connecting, setConnecting] = useState(false);
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline">
                        <Play />
                        Use
                        <ChevronDown aria-hidden="true" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem
                        disabled={!row.can_test}
                        onSelect={() => router.history.push(playgroundHref(row.key))}
                    >
                        <Play />
                        Playground
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setConnecting(true)}>
                        <Plug />
                        API Connect
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <ConnectDialog row={row} open={connecting} onOpenChange={setConnecting} />
        </>
    );
}

function TrainButton({
    row,
    detail,
    base,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    base: BaseModelDetail | undefined;
}) {
    const router = useRouter();
    const found = trainBlock(row, detail, base);
    const serveOnly = detail?.serve_only ?? row.serve_only;
    const promptOnly = Boolean(serveOnly) && found === serveOnly?.reason;
    const blocked = promptOnly ? null : found;
    return (
        <Tip tip={promptOnly ? `${found} Instructions only.` : blocked}>
            <Button
                variant="outline"
                disabled={Boolean(blocked)}
                onClick={() =>
                    router.history.push(
                        trainHref(row.key, promptOnly ? { method: "instructions" } : {}),
                    )
                }
            >
                <GraduationCap />
                Train
            </Button>
        </Tip>
    );
}

export function ModelActions({
    row,
    detail,
    base,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    base: BaseModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const can = useCan();
    if (!can.build) {
        return <UseMenu row={row} />;
    }
    return (
        <>
            {row.kind === "custom" ? (
                <TrainButton row={row} detail={detail} base={base} />
            ) : (
                <Button variant="outline" asChild>
                    <Link href={`/models/new?base=${encodeURIComponent(row.key)}`}>
                        <SquarePlus />
                        Create custom model
                    </Link>
                </Button>
            )}
            <DeployButton row={row} base={base} versions={versions} />
            <UseMenu row={row} />
        </>
    );
}
