import { useRouter } from "@tanstack/react-router";
import {
    ChevronDown,
    CopyPlus,
    GraduationCap,
    MoreHorizontal,
    Pencil,
    Play,
    Plug,
    Replace,
    Rocket,
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
import { PickerDialog } from "~/components/avatar/AvatarPicker";
import { choiceFor } from "~/components/avatar/avatarSvg";
import { deploymentOf, downloadingBase, useCompute, useNow } from "./flowCompute";
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
                                        `Would copy ${model.name} with its settings; pick another dataset for the copy.`,
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

function DeployButton({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const download = useDownload(model);
    const deployment = deploymentOf(model, compute);
    const [open, setOpen] = useState(false);
    const blocked = download
        ? `Waits for ${download.name} to download.`
        : deployment?.job
          ? `Rollout job #${deployment.job} is running.`
          : null;
    return (
        <>
            <Tip tip={blocked}>
                <Button variant="outline" disabled={Boolean(blocked)} onClick={() => setOpen(true)}>
                    <Rocket />
                    Deploy
                </Button>
            </Tip>
            <DeployDialog model={model} open={open} onOpenChange={setOpen} />
        </>
    );
}

function UseMenu({ model }: { model: FlowModel }) {
    const router = useRouter();
    const download = useDownload(model);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline">
                    <Play />
                    Use
                    <ChevronDown aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                    disabled={Boolean(download)}
                    onSelect={() => router.history.push(playgroundHref(model.slug))}
                >
                    <Play />
                    Playground
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openConnect(model.slug)}>
                    <Plug />
                    API Connect
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
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
            <DeployButton model={model} />
            <UseMenu model={model} />
            <MoreMenu model={model} />
        </>
    );
}
