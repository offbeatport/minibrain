import { useRouter } from "@tanstack/react-router";
import {
    CopyPlus,
    GraduationCap,
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
import { type ReactNode, useState } from "react";
import { PickerDialog } from "./AvatarPicker";
import { choiceFor } from "./avatarDicebear";
import { openTrain, useCan } from "./flowOverlays";
import { trainBlock } from "./flowTraining";
import {
    FLOW,
    type FlowModel,
    deleteModels,
    editModel,
    flowHref,
    nextNumber,
    playgroundHref,
    setOnApi,
} from "./modelsFlowData";
import { AutopilotDialog, type Confirm, ConfirmDialog } from "./modelsFlowDialogs";
import { Tip, openConnect } from "./modelsFlowParts";

function nothingLive(model: FlowModel): boolean {
    return model.kind === "custom" && model.live === null;
}

function notInPrototype(toast: ReturnType<typeof useToast>, what: string) {
    return () => toast({ title: "Not in the prototype", description: what });
}

function BlockedItem({
    icon,
    label,
    blocked,
    onSelect,
}: {
    icon: ReactNode;
    label: string;
    blocked: string | null;
    onSelect: () => void;
}) {
    return (
        <DropdownMenuItem
            disabled={Boolean(blocked)}
            className={blocked ? "items-start [&>svg]:mt-0.5" : undefined}
            onSelect={onSelect}
        >
            {icon}
            <span className="flex flex-col">
                <span>{label}</span>
                {blocked && (
                    <span className="text-sm whitespace-normal text-muted-foreground">
                        {blocked}
                    </span>
                )}
            </span>
        </DropdownMenuItem>
    );
}

function ModelMenu({ model }: { model: FlowModel }) {
    const router = useRouter();
    const toast = useToast();
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [autopilot, setAutopilot] = useState(false);
    const [picking, setPicking] = useState(false);
    const custom = model.kind === "custom";
    const deploy = () => {
        setOnApi(model.slug, true);
        toast({ title: `${model.name} deployed`, tone: "success" });
    };
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
                        {model.deployed ? (
                            <DropdownMenuItem onSelect={undeploy}>
                                <PowerOff />
                                {custom ? "Undeploy" : "Undeploy every format"}
                            </DropdownMenuItem>
                        ) : (
                            <BlockedItem
                                icon={<Power />}
                                label="Deploy"
                                blocked={nothingLive(model) ? "Make a version live first." : null}
                                onSelect={deploy}
                            />
                        )}
                        {custom && (
                            <BlockedItem
                                icon={<GraduationCap />}
                                label={`Train v${nextNumber(model)}`}
                                blocked={trainBlock(model)}
                                onSelect={() => openTrain(model.slug)}
                            />
                        )}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                        {custom ? (
                            <>
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
                                <DropdownMenuItem onSelect={() => setAutopilot(true)}>
                                    <Repeat />
                                    {model.autopilot ? "Autopilot settings" : "Turn on autopilot"}
                                </DropdownMenuItem>
                            </>
                        ) : (
                            <DropdownMenuItem
                                onSelect={() =>
                                    router.history.push(`${FLOW}/models/new?base=${model.slug}`)
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
                </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
            <AutopilotDialog model={autopilot ? model : null} onClose={() => setAutopilot(false)} />
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

function PlaygroundButton({ model }: { model: FlowModel }) {
    const playable =
        model.kind === "base"
            ? model.variants.length > 0
            : model.versions.some((version) => version.status === "ready");
    if (!playable) {
        return (
            <Tip tip="Nothing to try yet: train a version first.">
                <Button variant="outline" disabled>
                    <Play />
                    Playground
                </Button>
            </Tip>
        );
    }
    return (
        <Button variant="outline" asChild>
            <Link href={playgroundHref(model.slug)}>
                <Play />
                Playground
            </Link>
        </Button>
    );
}

export function ModelHeaderActions({ model }: { model: FlowModel }) {
    const can = useCan("builder");
    return (
        <>
            <PlaygroundButton model={model} />
            <Button variant="outline" onClick={() => openConnect(model.slug)}>
                <Plug />
                Connect
            </Button>
            {can && <ModelMenu model={model} />}
        </>
    );
}
