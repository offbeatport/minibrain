import { useRouter } from "@tanstack/react-router";
import {
    CopyPlus,
    MoreHorizontal,
    Pencil,
    Play,
    Plug,
    Power,
    PowerOff,
    Repeat,
    Replace,
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
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Link,
    useToast,
} from "obp-ui";
import { useState } from "react";
import { useCan } from "./flowOverlays";
import { TrainButton } from "./flowTraining";
import {
    FLOW,
    type FlowModel,
    deleteModels,
    flowHref,
    nextStep,
    openIntent,
    playgroundHref,
    setOnApi,
    useFlowState,
} from "./modelsFlowData";
import { AutopilotDialog, type Confirm, ConfirmDialog } from "./modelsFlowDialogs";
import { openConnect } from "./modelsFlowParts";

type Primary =
    | { kind: "add-data" }
    | { kind: "train" }
    | { kind: "make-live"; number: number }
    | { kind: "deploy" }
    | { kind: "connect" };

function nothingLive(model: FlowModel): boolean {
    return model.kind === "custom" && model.live === null;
}

function usePrimary(model: FlowModel): Primary {
    const state = useFlowState();
    if (model.kind === "base") {
        return model.deployed ? { kind: "connect" } : { kind: "deploy" };
    }
    if (!model.dataset) {
        return { kind: "add-data" };
    }
    const step = nextStep(state, model);
    if (step?.action === "make-live" && step.version !== undefined) {
        return { kind: "make-live", number: step.version };
    }
    if (!model.deployed && model.live !== null) {
        return { kind: "deploy" };
    }
    return model.serveOnly ? { kind: "connect" } : { kind: "train" };
}

function useDeploy(model: FlowModel) {
    const toast = useToast();
    return () => {
        setOnApi(model.slug, true);
        toast({ title: `${model.name} deployed`, tone: "success" });
    };
}

function PrimaryButton({ model, primary }: { model: FlowModel; primary: Primary }) {
    const deploy = useDeploy(model);
    if (primary.kind === "add-data") {
        return (
            <Button asChild>
                <Link href={`${FLOW}/data?for=${model.slug}`}>Add data</Link>
            </Button>
        );
    }
    if (primary.kind === "train") {
        return <TrainButton model={model} />;
    }
    if (primary.kind === "make-live") {
        return (
            <Button
                onClick={() =>
                    openIntent({ kind: "make-live", slug: model.slug, number: primary.number })
                }
            >
                {`Make v${primary.number} live`}
            </Button>
        );
    }
    if (primary.kind === "deploy") {
        return <Button onClick={deploy}>Deploy</Button>;
    }
    return <Button onClick={() => openConnect(model.slug)}>Connect</Button>;
}

function notInPrototype(toast: ReturnType<typeof useToast>, what: string) {
    return () => toast({ title: "Not in the prototype", description: what });
}

function ModelMenu({ model, primary }: { model: FlowModel; primary: Primary | null }) {
    const router = useRouter();
    const toast = useToast();
    const can = useCan("builder");
    const deploy = useDeploy(model);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [autopilot, setAutopilot] = useState(false);
    const canPlay =
        model.kind === "base" || model.versions.some((version) => version.status === "ready");
    const custom = model.kind === "custom";
    const undeploy = () =>
        setConfirm({
            title: `Undeploy ${model.name}?`,
            description: (
                <p>{`Apps calling ${model.slug} get errors at once. The live pointer, versions and keys stay.`}</p>
            ),
            label: `Undeploy ${model.name}`,
            run: () => {
                setOnApi(model.slug, false);
                toast({ title: `${model.name} undeployed` });
            },
        });
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
                <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuGroup>
                        <DropdownMenuItem
                            disabled={!canPlay}
                            onSelect={() => router.history.push(playgroundHref(model.slug))}
                        >
                            <Play />
                            Open in Playground
                        </DropdownMenuItem>
                        {primary?.kind !== "connect" && (
                            <DropdownMenuItem onSelect={() => openConnect(model.slug)}>
                                <Plug />
                                Connect
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuGroup>
                    {can && (model.deployed || primary?.kind !== "deploy") && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                                {model.deployed ? (
                                    <DropdownMenuItem onSelect={undeploy}>
                                        <PowerOff />
                                        {custom ? "Undeploy" : "Undeploy every format"}
                                    </DropdownMenuItem>
                                ) : (
                                    <DropdownMenuItem
                                        disabled={nothingLive(model)}
                                        className={nothingLive(model) ? "items-start" : undefined}
                                        onSelect={deploy}
                                    >
                                        <Power
                                            className={nothingLive(model) ? "mt-0.5" : undefined}
                                        />
                                        <span className="flex flex-col">
                                            <span>Deploy</span>
                                            {nothingLive(model) && (
                                                <span className="text-sm whitespace-normal text-muted-foreground">
                                                    Make a version live first.
                                                </span>
                                            )}
                                        </span>
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuGroup>
                        </>
                    )}
                    {can && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                                {custom ? (
                                    <>
                                        <DropdownMenuItem
                                            onSelect={later(`Would rename ${model.name}.`)}
                                        >
                                            <Pencil />
                                            Rename
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onSelect={later(
                                                `Would change the avatar of ${model.name}.`,
                                            )}
                                        >
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
                                            onSelect={later(
                                                `Would train ${model.name} on another base.`,
                                            )}
                                        >
                                            <Replace />
                                            Switch base
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onSelect={() => setAutopilot(true)}>
                                            <Repeat />
                                            {model.autopilot
                                                ? "Autopilot settings"
                                                : "Turn on autopilot"}
                                        </DropdownMenuItem>
                                    </>
                                ) : (
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            router.history.push(
                                                `${FLOW}/models/new?base=${model.slug}`,
                                            )
                                        }
                                    >
                                        <SquarePlus />
                                        Add a model on it
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={remove}>
                                <Trash2 />
                                Delete model
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
            <AutopilotDialog model={autopilot ? model : null} onClose={() => setAutopilot(false)} />
        </>
    );
}

export function ModelHeaderActions({ model }: { model: FlowModel }) {
    const can = useCan("builder");
    const primary = usePrimary(model);
    return (
        <>
            {can && <PrimaryButton model={model} primary={primary} />}
            <ModelMenu model={model} primary={can ? primary : null} />
        </>
    );
}
