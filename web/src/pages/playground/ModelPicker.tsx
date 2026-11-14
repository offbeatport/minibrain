import { type ChatModel, ChatModelPicker } from "obp-ui/chat";
import { useMemo } from "react";
import type { ModelRow } from "~/api/client";
import { useModels } from "~/api/queries";
import { providerOf } from "~/components/PublisherLogo";
import { ModelAvatar } from "~/components/avatar/ModelAvatar";
import type { Target } from "~/lib/playground";

const HINT =
    "Any version of your models, the live one by name, or any base on this install, deployed or not.";

function targetLabel(target: Target): string {
    if (target.kind === "base") {
        return target.model_name;
    }
    return target.live
        ? `${target.model_name} · live`
        : `${target.model_name} · v${target.version}`;
}

function chatModel(target: Target, rows: Map<string, ModelRow>): ChatModel {
    const custom = target.kind === "custom";
    const row = custom ? rows.get(target.key) : undefined;
    return {
        id: target.name,
        name: targetLabel(target),
        provider: providerOf(target.publisher),
        icon: custom ? (
            <ModelAvatar name={target.model_name} avatar={row?.avatar} size="sm" />
        ) : undefined,
        group: custom ? "Your models" : "Base models",
        detail: custom ? (
            <span className="font-mono">{target.name}</span>
        ) : target.deployed ? (
            "Deployed"
        ) : (
            "Installed, not deployed"
        ),
        keywords: [target.key, target.model_name, target.base].join(" "),
    };
}

export function ModelPicker({
    targets,
    model,
    onModel,
}: {
    targets: Target[];
    model: string;
    onModel: (name: string) => void;
}) {
    const rows = useModels().data;
    const models = useMemo(() => {
        const byKey = new Map((rows ?? []).map((row) => [row.key, row]));
        return [
            ...targets.filter((item) => item.kind === "custom"),
            ...targets.filter((item) => item.kind === "base"),
        ].map((target) => chatModel(target, byKey));
    }, [targets, rows]);
    return <ChatModelPicker models={models} value={model} onValueChange={onModel} hint={HINT} />;
}
