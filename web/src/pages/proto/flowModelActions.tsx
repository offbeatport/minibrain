import { useRouter } from "@tanstack/react-router";
import {
    ChevronDown,
    CopyPlus,
    GraduationCap,
    MoreHorizontal,
    Pencil,
    Play,
    Plug,
    PowerOff,
    Replace,
    Rocket,
    Server,
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
import { type ReactNode, useState } from "react";
import { PickerDialog } from "~/components/avatar/AvatarPicker";
import { choiceFor } from "~/components/avatar/avatarSvg";
import {
    deploymentOf,
    downloadingBase,
    liveReplicas,
    undeployModel,
    useCompute,
    useNow,
} from "./flowCompute";
import { DeployDialog } from "./flowDeploy";
import { openTrain, useCan } from "./flowOverlays";
import { trainBlock } from "./flowTraining";
import {
    FLOW,
    type FlowModel,
    deleteModels,
    editModel,
    flowHref,
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

function UseMenu({ model }: { model: FlowModel }) {
    const router = useRouter();
    const download = useDownload(model);
    const tryIt = () => {
        router.history.push(playgroundHref(model.slug));
    };
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button>
                    <Play />
                    Use
                    <ChevronDown aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem disabled={Boolean(download)} onSelect={tryIt}>
                    <Play />
                    <span className="flex flex-col">
                        <span>Try it in the Playground</span>
                        <span className="text-sm whitespace-normal text-muted-foreground">
                            {download
                                ? `Waits for ${download.name} to download.`
                                : model.deployed
                                  ? "Runs on its deployment."
                                  : "Loads it on demand; it unloads when idle."}
                        </span>
                    </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openConnect(model.slug)}>
                    <Plug />
                    <span className="flex flex-col">
                        <span>Connect</span>
                        <span className="text-sm whitespace-normal text-muted-foreground">
                            Call it from code through /v1.
                        </span>
                    </span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function DeployControl({ model }: { model: FlowModel }) {
    const router = useRouter();
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const download = useDownload(model);
    const [dialog, setDialog] = useState<"deploy" | "change" | null>(null);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const toast = useToast();
    const deployment = deploymentOf(model, compute);
    const replicas = liveReplicas(model);
    const where =
        model.kind === "custom"
            ? model.replicas
            : [...new Set(model.variants.flatMap((item) => item.replicas))];
    const idleFormats = model.kind === "base" && model.variants.some((item) => !item.live);
    const askUndeploy = () =>
        setConfirm({
            title: `Undeploy ${model.name}?`,
            description: (
                <p>
                    {`Apps calling ${model.slug} get errors at once. Its engine unloads ${model.kind === "custom" ? "the adapter, and the base too if nothing else needs it" : "the base unless a custom model still needs it"}. Versions and keys stay.`}
                </p>
            ),
            label: "Undeploy",
            run: () => {
                undeployModel(model);
                toast({
                    title: `Undeploying ${model.name}`,
                    description: "Infrastructure shows it unloading.",
                });
            },
        });
    let control: ReactNode;
    if (deployment) {
        control = (
            <Button variant="outline" disabled>
                <Rocket />
                {deployment.phase === "undeploying" ? "Undeploying" : "Deploying"}
            </Button>
        );
    } else if (model.deployed) {
        control = (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline">
                        <Rocket />
                        Deployed
                        <ChevronDown aria-hidden="true" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel className="font-normal text-muted-foreground tabular-nums">
                        {`${replicas} ${replicas === 1 ? "replica" : "replicas"} on ${where.join(", ")}`}
                    </DropdownMenuLabel>
                    <DropdownMenuItem
                        onSelect={() => router.history.push(`${FLOW}/infrastructure`)}
                    >
                        <Server />
                        See it in Infrastructure
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {idleFormats && (
                        <DropdownMenuItem onSelect={() => setDialog("deploy")}>
                            <Rocket />
                            Deploy another format
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setDialog("change")}>
                        <SlidersHorizontal />
                        Change pool or replicas
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={askUndeploy}>
                        <PowerOff />
                        {model.kind === "custom" ? "Undeploy" : "Undeploy every format"}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    } else {
        control = (
            <Tip tip={download ? `Waits for ${download.name} to download.` : null}>
                <Button
                    variant="outline"
                    disabled={Boolean(download)}
                    onClick={() => setDialog("deploy")}
                >
                    <Rocket />
                    Deploy
                </Button>
            </Tip>
        );
    }
    return (
        <>
            {control}
            <DeployDialog
                model={model}
                changing={dialog === "change"}
                open={dialog !== null}
                onOpenChange={(open) => !open && setDialog(null)}
            />
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
            <DeployControl model={model} />
            <UseMenu model={model} />
            <MoreMenu model={model} />
        </>
    );
}
