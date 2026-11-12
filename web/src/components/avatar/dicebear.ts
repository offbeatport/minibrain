import { Avatar, Style } from "@dicebear/core";
import pixelbotDefinition from "@dicebear/styles/pixelbot.json";
import planetsDefinition from "@dicebear/styles/planets.json";
import voxelBotDefinition from "@dicebear/styles/voxel-bot.json";
import type { Options, SeededStyleId } from "./avatarStyles";

const DEFINITIONS: Record<SeededStyleId, unknown> = {
    planets: planetsDefinition,
    "voxel-bot": voxelBotDefinition,
    pixelbot: pixelbotDefinition,
};

const STYLES = new Map<SeededStyleId, Style>();

function styleOf(id: SeededStyleId): Style {
    const cached = STYLES.get(id);
    if (cached) {
        return cached;
    }
    const style = new Style(DEFINITIONS[id]);
    STYLES.set(id, style);
    return style;
}

function clean(svg: string): string {
    return svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<metadata[\s\S]*?<\/metadata>/, "");
}

export function renderSeeded(id: SeededStyleId, seed: string, options: Options): string {
    return clean(new Avatar(styleOf(id), { seed, idRandomization: true, ...options }).toString());
}
