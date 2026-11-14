import { type ChatModel, ChatModelPicker } from "obp-ui/chat";
import { useMemo } from "react";
import { providerOf } from "~/components/PublisherLogo";
import type { Target } from "~/lib/playground";

function targetLabel(target: Target): string {
    if (target.kind === "base") {
        return target.model_name;
    }
    return target.live
        ? `${target.model_name} · live`
        : `${target.model_name} · v${target.version}`;
}

function chatModel(target: Target): ChatModel {
    const custom = target.kind === "custom";
    return {
        id: target.name,
        name: targetLabel(target),
        provider: providerOf(target.publisher),
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
    const models = useMemo(
        () =>
            [
                ...targets.filter((item) => item.kind === "custom"),
                ...targets.filter((item) => item.kind === "base"),
            ].map(chatModel),
        [targets],
    );
    return <ChatModelPicker models={models} value={model} onValueChange={onModel} />;
}
