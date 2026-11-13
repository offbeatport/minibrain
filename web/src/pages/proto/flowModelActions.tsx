import { useRouter } from "@tanstack/react-router";
import {
    ChevronDown,
    CopyPlus,
    GraduationCap,
    ListChecks,
    MoreHorizontal,
    Pencil,
    Play,
    Plug,
    PowerOff,
    Replace,
    Rocket,
    SlidersHorizontal,
    SmilePlus,
    SquarePlus,
    Trash2,
} from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Link,
    useToast,
} from "obp-ui";
import { useState } from "react";
import { PickerDialog } from "~/components/avatar/AvatarPicker";
import { choiceFor } from "~/components/avatar/avatarSvg";
import {
    deploymentOf,
    downloadingBase,
    liveReplicas,
    placementNames,
    useCompute,
    useNow,
} from "./flowCompute";
import { DeployDialog, type DeployMode } from "./flowDeploy";
import { openTrain, useCan } from "./flowOverlays";
import { startUndeploy, undeployTargets } from "./flowRollout";
import { trainBlock } from "./flowTraining";
import {
    FLOW,
    type FlowModel,
    deleteModels,
    editModel,
    flowHref,
    jobHref,
    lastRollout,
    playgroundHref,
    useFlowState,
} from "./modelsFlowData";
import { type Confirm, ConfirmDialog } from "./modelsFlowDialogs";
import { Tip, openConnect } from "./modelsFlowParts";

function notInPrototype(toast: ReturnType<typeof useToast>, what: string) {
    return () => toast({ title: "Not in the prototype", description: what });
}

function useDownload(model: FlowModel) {
    const state = useFlowState();
    const now = useNow(500);
    return downloadingBase(model, state, now);
}

function MoreMenu({ model }: { model: FlowModel }) {
    const router = useRouter();
    const toast = useToast();
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [picking, setPicking] = useState(false);
    const custom = model.kind === "custom";
    const remove = () =>
        setConfirm({
            title: `Delete ${model.name}?`,
            description: (
                <p>
                    {custom
                        ? `${model.name} goes with every version, key and score.`
                        : `${model.name} goes with every variant file and key.`}
                </p>
            ),
            label: "Delete model",
            run: () => {
                deleteModels([model.slug]);
                toast({ title: `Deleted ${model.name}`, tone: "success" });
                router.history.push(flowHref());
            },
        });
    const later = (what: string) => notInPrototype(toast, what);
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon"
                        aria-label={`More actions for ${model.name}`}
                    >
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    {custom && (
                        <>
                            <DropdownMenuGroup>
                                <DropdownMenuItem onSelect={later(`Would rename ${model.name}.`)}>
                                    <Pencil />
                                    Rename
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setPicking(true)}>
                                    <SmilePlus />
                                    Change avatar
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={later(
                                        `Would copy ${model.name} with its data and settings.`,
                                    )}
                                >
                                    <CopyPlus />
                                    Duplicate
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={later(`Would train ${model.name} on another base.`)}
                                >
                                    <Replace />
                                    Switch base
                                </DropdownMenuItem>
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                        </>
                    )}
                    <DropdownMenuItem variant="destructive" onSelect={remove}>
                        <Trash2 />
                        Delete
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
            {custom && (
                <PickerDialog
                    open={picking}
                    onOpenChange={setPicking}
                    name={model.name}
                    value={model.avatar ?? choiceFor("initials", model.name)}
                    onUse={(avatar) => editModel(model.slug, { avatar })}
                />
            )}
        </>
    );
}

function deployedLine(model: FlowModel, compute: ReturnType<typeof useCompute>): string {
    const replicas = liveReplicas(model);
    const where =
        model.kind === "custom"
            ? model.replicas
            : [...new Set(model.variants.flatMap((item) => item.replicas))];
    const parts = [
        model.kind === "custom" && model.live !== null ? `v${model.live}` : null,
        where.join(", "),
        `${replicas} ${replicas === 1 ? "replica" : "replicas"}`,
    ];
    const deployment = deploymentOf(model, compute);
    if (deployment && deployment.phase !== "undeploying") {
        return `Deploying to ${placementNames(deployment.placements, compute)}`;
    }
    return `Deployed: ${parts.filter(Boolean).join(" · ")}`;
}

function DeployItems({
    model,
    onDeploy,
    onUndeploy,
}: {
    model: FlowModel;
    onDeploy: (mode: DeployMode) => void;
    onUndeploy: () => void;
}) {
    const router = useRouter();
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const download = useDownload(model);
    const deployment = deploymentOf(model, compute);
    const last = lastRollout(state, model.slug);
    const custom = model.kind === "custom";
    const idleFormats = model.kind === "base" && model.variants.some((item) => !item.live);
    if (deployment?.job) {
        const job = deployment.job;
        return (
            <>
                <DropdownMenuLabel className="font-normal text-muted-foreground tabular-nums">
                    {deployment.phase === "undeploying"
                        ? `Undeploying · job #${job}`
                        : `${deployedLine(model, compute)} · job #${job}`}
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => router.history.push(jobHref(job))}>
                    <ListChecks />
                    View rollout
                </DropdownMenuItem>
            </>
        );
    }
    if (!model.deployed) {
        return (
            <DropdownMenuItem disabled={Boolean(download)} onSelect={() => onDeploy("deploy")}>
                <Rocket />
                Deploy…
            </DropdownMenuItem>
        );
    }
    return (
        <>
            <DropdownMenuItem onSelect={() => onDeploy("change")}>
                <SlidersHorizontal />
                Change deployment…
            </DropdownMenuItem>
            {idleFormats && (
                <DropdownMenuItem onSelect={() => onDeploy("deploy")}>
                    <Rocket />
                    Deploy another format…
                </DropdownMenuItem>
            )}
            {last && (
                <DropdownMenuItem onSelect={() => router.history.push(jobHref(last.id))}>
                    <ListChecks />
                    View last rollout
                </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onUndeploy}>
                <PowerOff />
                {custom ? "Undeploy" : "Undeploy every format"}
            </DropdownMenuItem>
        </>
    );
}

function UseMenu({ model }: { model: FlowModel }) {
    const router = useRouter();
    const toast = useToast();
    const builder = useCan("builder");
    const download = useDownload(model);
    const [dialog, setDialog] = useState<DeployMode | null>(null);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const tryIt = () => {
        router.history.push(playgroundHref(model.slug));
    };
    const askUndeploy = () =>
        setConfirm({
            title: `Undeploy ${model.name}?`,
            description: (
                <p>
                    {`Apps calling ${model.slug} get errors at once. An Undeploy job stops routing, unloads ${model.kind === "custom" ? "the adapter, and the base too if nothing else needs it" : "the base unless a custom model still needs it"}. Versions and keys stay.`}
                </p>
            ),
            label: "Undeploy",
            run: () => {
                const ids = undeployTargets(model).map((target) => startUndeploy(model, target));
                const first = ids[0];
                toast({
                    title: `Undeploying ${model.name}`,
                    description: `Undeploy job #${first} stops routing and unloads it.`,
                    action: first
                        ? {
                              label: "View rollout",
                              onClick: () => router.history.push(jobHref(first)),
                          }
                        : undefined,
                });
            },
        });
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
                <DropdownMenuContent align="end" className="w-72">
                    <DropdownMenuItem disabled={Boolean(download)} onSelect={tryIt}>
                        <Play />
                        Try it in the Playground
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openConnect(model.slug)}>
                        <Plug />
                        API Connect
                    </DropdownMenuItem>
                    {builder && (
                        <>
                            <DropdownMenuSeparator />
                            <DeployItems
                                model={model}
                                onDeploy={setDialog}
                                onUndeploy={askUndeploy}
                            />
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            {builder && (
                <DeployDialog
                    model={model}
                    mode={dialog ?? "deploy"}
                    open={dialog !== null}
                    onOpenChange={(open) => !open && setDialog(null)}
                />
            )}
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
        </>
    );
}

function TrainButton({ model }: { model: FlowModel }) {
    const download = useDownload(model);
    const blocked = download ? `Waits for ${download.name} to download.` : trainBlock(model);
    return (
        <Tip tip={blocked}>
            <Button
                variant="outline"
                disabled={Boolean(blocked)}
                onClick={() => openTrain(model.slug)}
            >
                <GraduationCap />
                Train
            </Button>
        </Tip>
    );
}

export function ModelHeaderActions({ model }: { model: FlowModel }) {
    const builder = useCan("builder");
    if (!builder) {
        return <UseMenu model={model} />;
    }
    return (
        <>
            {model.kind === "custom" ? (
                <TrainButton model={model} />
            ) : (
                <Button variant="outline" asChild>
                    <Link href={`${FLOW}/models/new?base=${model.slug}`}>
                        <SquarePlus />
                        Create custom model
                    </Link>
                </Button>
            )}
            <UseMenu model={model} />
            <MoreMenu model={model} />
        </>
    );
}
