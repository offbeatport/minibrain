import { useMemo } from "react";
import type { ModelAvatar as Avatar, ModelSummary } from "~/api/client";
import { useModels } from "~/api/queries";
import { AvatarTile } from "./AvatarTile";
import { choiceOfModel } from "./avatarSvg";

export type ModelAvatarSize = "sm" | "md" | "lg";

export function ModelAvatar({
    name,
    avatar,
    size = "md",
    className,
}: {
    name: string;
    avatar?: Avatar | null;
    size?: ModelAvatarSize;
    className?: string;
}) {
    const choice = useMemo(() => choiceOfModel(avatar, name), [avatar, name]);
    return <AvatarTile choice={choice} name={name} size={size} className={className} />;
}

export function useCustomModel(name: string, key?: string | null): ModelSummary | undefined {
    const models = useModels().data;
    return useMemo(() => {
        const lowered = name.trim().toLowerCase();
        return (
            models?.find((item) => key && item.slug === key) ??
            models?.find((item) => item.name.trim().toLowerCase() === lowered)
        );
    }, [models, name, key]);
}
