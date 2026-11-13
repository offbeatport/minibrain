import { useRouter } from "@tanstack/react-router";
import { ChevronDown, GraduationCap, Play, Plug, Rocket, SquarePlus } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Link,
} from "obp-ui";
import { useState } from "react";
import { deploymentOf, downloadingBase, useCompute, useNow } from "./flowCompute";
import { DeployDialog } from "./flowDeploy";
import { openTrain, useCan } from "./flowOverlays";
import { trainBlock } from "./flowTraining";
import { FLOW, type FlowModel, playgroundHref, useFlowState } from "./modelsFlowData";
import { Tip, openConnect } from "./modelsFlowParts";

function useDownload(model: FlowModel) {
    const state = useFlowState();
    const now = useNow(500);
    return downloadingBase(model, state, now);
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
        </>
    );
}
