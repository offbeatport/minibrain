import { Avatar as DicebearAvatar, Style } from "@dicebear/core";
import botttsNeutralDefinition from "@dicebear/styles/bottts-neutral.json";
import botttsDefinition from "@dicebear/styles/bottts.json";
import initialsDefinition from "@dicebear/styles/initials.json";
import pixelbotDefinition from "@dicebear/styles/pixelbot.json";
import planetsDefinition from "@dicebear/styles/planets.json";
import voxelArtDefinition from "@dicebear/styles/voxel-art.json";
import voxelBotDefinition from "@dicebear/styles/voxel-bot.json";
import wavesDefinition from "@dicebear/styles/waves.json";
import { cn } from "obp-ui";
import { useMemo, useSyncExternalStore } from "react";
import { SvgMarkup, TONE_TOKENS, cleanDicebear, cyrb53, slugOf } from "./modelIcons";

export type AvatarStyleId =
    | "initials"
    | "waves"
    | "planets"
    | "voxel-art"
    | "voxel-bot"
    | "pixelbot"
    | "bottts"
    | "bottts-neutral";

export type AvatarChoice = { style: AvatarStyleId; seed: string; tone: number };

export type Palette = {
    tones: string[];
    surface: string;
    paper: string;
    ink: string;
    font: string;
};

type Options = Record<string, unknown>;

export type AvatarStyle = {
    id: AvatarStyleId;
    name: string;
    recommended: boolean;
    licence: string;
    licenceBadge: string;
    artist: string;
    recolour: string;
    at20: string;
    verdict: string;
    options: (palette: Palette, tone: string) => Options;
};

export const TONE_NAMES = [
    "Green",
    "Teal",
    "Amber",
    "Orange",
    "Indigo",
    "Purple",
    "Sky",
    "Lime",
    "Pink",
    "Slate",
];

const DEFINITIONS: Record<AvatarStyleId, unknown> = {
    initials: initialsDefinition,
    waves: wavesDefinition,
    planets: planetsDefinition,
    "voxel-art": voxelArtDefinition,
    "voxel-bot": voxelBotDefinition,
    pixelbot: pixelbotDefinition,
    bottts: botttsDefinition,
    "bottts-neutral": botttsNeutralDefinition,
};

const STYLES = new Map<AvatarStyleId, Style>();

function styleOf(id: AvatarStyleId): Style {
    const cached = STYLES.get(id);
    if (cached) {
        return cached;
    }
    const style = new Style(DEFINITIONS[id]);
    STYLES.set(id, style);
    return style;
}

function channels(hex: string): number[] {
    return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

function hexOf(values: ArrayLike<number>): string {
    return `#${Array.from(values, (value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

export function mixHex(color: string, other: string, weight: number): string {
    const right = channels(other);
    return hexOf(
        channels(color).map((value, index) => value * weight + right[index] * (1 - weight)),
    );
}

function luminance(hex: string): number {
    const [red, green, blue] = channels(hex).map((value) => {
        const unit = value / 255;
        return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

const LICENCE_CC0 = "CC0 1.0";
const LICENCE_BOTTTS = "Free for personal and commercial use (bottts.com, the artist's own terms)";

export const AVATAR_STYLES: AvatarStyle[] = [
    {
        id: "initials",
        name: "Initials",
        recommended: true,
        licence: LICENCE_CC0,
        licenceBadge: LICENCE_CC0,
        artist: "DiceBear",
        recolour:
            "Yes, fully: one background tone, picked by the user; letters take card or foreground ink, whichever contrasts more",
        at20: "Yes: two letters at 10 px",
        verdict: "Keep: the quiet default and the only one the user colours by hand",
        options: (palette, tone) => ({
            initialsVariant: "alt",
            backgroundColor: [tone],
            textColor: [palette.paper, palette.ink],
            fontFamily: palette.font,
            fontWeight: 600,
        }),
    },
    {
        id: "waves",
        name: "Waves",
        recommended: true,
        licence: LICENCE_CC0,
        licenceBadge: LICENCE_CC0,
        artist: "DiceBear",
        recolour: "Yes, fully: background from the ten tones, waves in card or foreground ink",
        at20: "Yes, as a tone tile; the waves blur together",
        verdict:
            "Maybe: calm and on palette, but its stacked translucent layers read as a stepped gradient",
        options: (palette, tone) => ({
            backgroundColor: [tone],
            waveColor: [palette.paper, palette.ink],
        }),
    },
    {
        id: "planets",
        name: "Planets",
        recommended: true,
        licence: LICENCE_CC0,
        licenceBadge: LICENCE_CC0,
        artist: "DiceBear",
        recolour:
            "Yes: sky is the tone sunk into the ink, planet the tone lifted towards paper, moons paper. Its radial-gradient shade stays",
        at20: "Partly: a coloured disc on a dark tile; rings and moons vanish",
        verdict: "Maybe: the most character, but dark in light theme and it carries a gradient",
        options: (palette, tone) => ({
            backgroundColor: [mixHex(tone, palette.ink, 0.28)],
            planetColor: [mixHex(tone, palette.paper, 0.7)],
            moonColor: [mixHex(palette.paper, tone, 0.85)],
        }),
    },
    {
        id: "voxel-art",
        name: "Voxel Art",
        recommended: true,
        licence: LICENCE_CC0,
        licenceBadge: LICENCE_CC0,
        artist: "DiceBear",
        recolour:
            "Partly: background tint, shirt and hat take the tones; skin, hair, trousers and shoes keep the style's own colours",
        at20: "No: a full figure shrinks to a few pixels",
        verdict: "Drop for model avatars: a person, not a model, and unreadable small",
        options: (palette, tone) => ({
            backgroundColor: [mixHex(tone, palette.surface, 0.25)],
            shirtColor: [tone],
            hatColor: [mixHex(tone, palette.ink, 0.7)],
        }),
    },
    {
        id: "voxel-bot",
        name: "Voxel Bot",
        recommended: true,
        licence: LICENCE_CC0,
        licenceBadge: LICENCE_CC0,
        artist: "DiceBear",
        recolour:
            "Mostly: background tint and body take the tones; accent, screen and glow keep the style's colours",
        at20: "Barely: the cube reads, the face does not",
        verdict: "Maybe at 32 px and up; weak in lists",
        options: (palette, tone) => ({
            backgroundColor: [mixHex(tone, palette.surface, 0.25)],
            bodyColor: [mixHex(tone, palette.paper, 0.75)],
        }),
    },
    {
        id: "pixelbot",
        name: "Pixelbot",
        recommended: true,
        licence: LICENCE_CC0,
        licenceBadge: LICENCE_CC0,
        artist: "DiceBear",
        recolour: "Yes, fully: a dark ground tinted by the tone, the face lit in the tone",
        at20: "Yes: eyes and mouth stay legible as a lit grid",
        verdict: "Keep: the most personality that still reads at 20 px",
        options: (palette, tone) => ({
            backgroundColor: [mixHex(tone, palette.ink, 0.24)],
            glowColor: [mixHex(tone, palette.paper, 0.35)],
        }),
    },
    {
        id: "bottts",
        name: "Bottts",
        recommended: false,
        licence: LICENCE_BOTTTS,
        licenceBadge: "Artist's own terms",
        artist: "Pablo Stanley",
        recolour:
            "Partly: robot base and background take the tones; eyes, mouth and texture are fixed artwork",
        at20: "Partly: a coloured head, detail is lost",
        verdict: "Compare only: artist's terms, blur filter, busy",
        options: (palette, tone) => ({
            backgroundColor: [mixHex(tone, palette.surface, 0.25)],
            baseColor: [tone],
        }),
    },
    {
        id: "bottts-neutral",
        name: "Bottts Neutral",
        recommended: false,
        licence: LICENCE_BOTTTS,
        licenceBadge: "Artist's own terms",
        artist: "Pablo Stanley",
        recolour: "Background only; eyes and mouth are fixed artwork",
        at20: "Yes: a face on a tone",
        verdict: "Compare only: reads well, but artist's terms",
        options: (_palette, tone) => ({
            backgroundColor: [tone],
        }),
    },
];

const STYLE_BY_ID = new Map(AVATAR_STYLES.map((style) => [style.id, style]));

function defaultTone(name: string): number {
    return cyrb53(slugOf(name)) % TONE_TOKENS.length;
}

export function baseSeed(name: string): string {
    return slugOf(name) || "model";
}

export function seedTone(name: string, seed: string): number {
    return seed === baseSeed(name) ? defaultTone(name) : cyrb53(seed) % TONE_TOKENS.length;
}

export function randomSeed(name: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return `${baseSeed(name)}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function avatarSvg(choice: AvatarChoice, name: string, palette: Palette): string {
    const style = STYLE_BY_ID.get(choice.style) ?? AVATAR_STYLES[0];
    const tone = palette.tones[choice.tone] ?? palette.tones[0];
    const seed = style.id === "initials" ? name.trim() || "?" : choice.seed;
    const svg = new DicebearAvatar(styleOf(style.id), {
        seed,
        idRandomization: true,
        ...style.options(palette, tone),
    }).toString();
    return cleanDicebear(svg);
}

const FEATURES: { label: string; pattern: RegExp }[] = [
    { label: "linear gradient", pattern: /<linearGradient/g },
    { label: "radial gradient", pattern: /<radialGradient/g },
    { label: "filter", pattern: /<filter/g },
    { label: "Gaussian blur", pattern: /feGaussianBlur/g },
    { label: "blend mode", pattern: /mix-blend-mode/g },
    { label: "mask", pattern: /<mask/g },
    { label: "animation", pattern: /<animate|@keyframes/g },
    { label: "opacity", pattern: /opacity=/g },
];

export function featuresOf(markups: string[]): { label: string; count: number }[] {
    return FEATURES.map(({ label, pattern }) => ({
        label,
        count: markups.reduce((total, markup) => total + (markup.match(pattern)?.length ?? 0), 0),
    }));
}

let canvas: HTMLCanvasElement | undefined;

function resolveColor(color: string): string {
    canvas ??= document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
        return "#808080";
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#808080";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return hexOf(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
}

function fontFamilies(value: string): string {
    const families = value
        .split(",")
        .map((family) => family.trim().replace(/^["']|["']$/g, ""))
        .filter((family) => /^[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*$/.test(family));
    return families.length > 0 ? families.join(", ") : "sans-serif";
}

function readPalette(): Palette {
    const computed = getComputedStyle(document.documentElement);
    const token = (name: string) => resolveColor(computed.getPropertyValue(name).trim());
    const card = token("--card");
    const foreground = token("--foreground");
    const cardIsLight = luminance(card) > luminance(foreground);
    return {
        tones: TONE_TOKENS.map(token),
        surface: card,
        paper: cardIsLight ? card : foreground,
        ink: cardIsLight ? foreground : card,
        font: fontFamilies(computed.getPropertyValue("--font-sans")),
    };
}

let palette: Palette | undefined;
let paletteKey = "";
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function refresh(): void {
    const next = readPalette();
    const key = JSON.stringify(next);
    if (key === paletteKey) {
        return;
    }
    palette = next;
    paletteKey = key;
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!observer) {
        observer = new MutationObserver(refresh);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style", "data-theme"],
        });
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            observer?.disconnect();
            observer = undefined;
        }
    };
}

function currentPalette(): Palette {
    if (!palette) {
        refresh();
    }
    return palette as Palette;
}

export function usePalette(): Palette {
    return useSyncExternalStore(subscribe, currentPalette);
}

function useAvatarSvg(choice: AvatarChoice, name: string): string {
    const current = usePalette();
    const { style, seed, tone } = choice;
    return useMemo(
        () => avatarSvg({ style, seed, tone }, name, current),
        [style, seed, tone, name, current],
    );
}

export type AvatarSize = "sm" | "md" | "lg" | "xl";

const AVATAR_TILE: Record<AvatarSize, string> = {
    sm: "size-5",
    md: "size-8",
    lg: "size-12",
    xl: "size-24",
};

export function AvatarTile({
    choice,
    name,
    size,
    className,
}: {
    choice: AvatarChoice;
    name: string;
    size: AvatarSize;
    className?: string;
}) {
    const markup = useAvatarSvg(choice, name);
    return (
        <span
            aria-hidden="true"
            className={cn("flex shrink-0 overflow-hidden rounded-md", AVATAR_TILE[size], className)}
        >
            <SvgMarkup markup={markup} />
        </span>
    );
}
