import { Avatar as DicebearAvatar, Style } from "@dicebear/core";
import initialsDefinition from "@dicebear/styles/initials.json";
import pixelbotDefinition from "@dicebear/styles/pixelbot.json";
import planetsDefinition from "@dicebear/styles/planets.json";
import voxelBotDefinition from "@dicebear/styles/voxel-bot.json";
import { cn } from "obp-ui";
import { useMemo, useSyncExternalStore } from "react";
import { appPresetStyle } from "~/lib/theme";
import { type AvatarStyleId, type Palette, hexOf, luminance, styleById } from "./avatarStyles";
import {
    SvgMarkup,
    TONE_KEYS,
    type ToneName,
    cleanDicebear,
    cyrb53,
    slugOf,
    toneToken,
} from "./modelIcons";

export type AvatarChoice = { style: AvatarStyleId; seed: string; tone: ToneName };

export const TONE_LABELS: Record<ToneName, string> = {
    csv: "Green",
    tsv: "Teal",
    json: "Amber",
    jsonl: "Orange",
    parquet: "Indigo",
    avro: "Purple",
    iceberg: "Sky",
    delta: "Lime",
    sql: "Pink",
    text: "Slate",
};

const DEFINITIONS: Record<AvatarStyleId, unknown> = {
    initials: initialsDefinition,
    planets: planetsDefinition,
    "voxel-bot": voxelBotDefinition,
    pixelbot: pixelbotDefinition,
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

function toneAt(hash: number): ToneName {
    return TONE_KEYS[hash % TONE_KEYS.length];
}

function defaultTone(name: string): ToneName {
    return toneAt(cyrb53(slugOf(name)));
}

export function baseSeed(name: string): string {
    return slugOf(name) || "model";
}

export function seedTone(name: string, seed: string): ToneName {
    return seed === baseSeed(name) ? defaultTone(name) : toneAt(cyrb53(seed));
}

export function choiceFor(style: AvatarStyleId, name: string, seed = baseSeed(name)): AvatarChoice {
    return { style, seed, tone: seedTone(name, seed) };
}

export function randomSeed(name: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return `${baseSeed(name)}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function avatarSvg(choice: AvatarChoice, name: string, palette: Palette): string {
    const style = styleById(choice.style);
    const tone = palette.tones[choice.tone] ?? palette.tones.csv;
    const seed = style.id === "initials" ? name.trim() || "?" : choice.seed;
    const svg = cleanDicebear(
        new DicebearAvatar(styleOf(style.id), {
            seed,
            idRandomization: true,
            ...style.options(palette, tone),
        }).toString(),
    );
    return style.paint ? style.paint(svg, palette, tone) : svg;
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

function paletteFrom(read: (token: string) => string): Palette {
    const token = (name: string) => resolveColor(read(name));
    const card = token("--card");
    const foreground = token("--foreground");
    const cardIsLight = luminance(card) > luminance(foreground);
    return {
        tones: Object.fromEntries(TONE_KEYS.map((key) => [key, token(toneToken(key))])) as Record<
            ToneName,
            string
        >,
        background: token("--background"),
        foreground,
        surface: card,
        paper: cardIsLight ? card : foreground,
        ink: cardIsLight ? foreground : card,
        font: fontFamilies(read("--font-sans")),
    };
}

function readPalette(): Palette {
    const computed = getComputedStyle(document.documentElement);
    return paletteFrom((name) => computed.getPropertyValue(name).trim());
}

function declaredTokens(selector: string): Map<string, string> {
    const found = new Map<string, string>();
    const visit = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
            if (
                rule instanceof CSSStyleRule &&
                rule.selectorText.split(",").some((part) => part.trim() === selector)
            ) {
                for (const property of Array.from(rule.style)) {
                    if (property.startsWith("--")) {
                        found.set(property, rule.style.getPropertyValue(property).trim());
                    }
                }
            }
            if ("cssRules" in rule) {
                visit((rule as CSSGroupingRule).cssRules);
            }
        }
    };
    for (const sheet of Array.from(document.styleSheets)) {
        const rules = readableRules(sheet);
        if (rules) {
            visit(rules);
        }
    }
    return found;
}

function readableRules(sheet: CSSStyleSheet): CSSRuleList | undefined {
    try {
        return sheet.cssRules;
    } catch {
        return undefined;
    }
}

export type ThemeMode = "light" | "dark";

export function modePalette(mode: ThemeMode, fallback: Palette): Palette {
    const preset = appPresetStyle(mode);
    const light = declaredTokens(":root");
    const declared = mode === "dark" ? new Map([...light, ...declaredTokens(".dark")]) : light;
    const computed = getComputedStyle(document.documentElement);
    return {
        ...paletteFrom(
            (name) => preset[name] ?? declared.get(name) ?? computed.getPropertyValue(name).trim(),
        ),
        font: fallback.font,
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
            className={cn(
                "flex shrink-0 overflow-hidden rounded-md border bg-background",
                AVATAR_TILE[size],
                className,
            )}
        >
            <SvgMarkup markup={markup} />
        </span>
    );
}
