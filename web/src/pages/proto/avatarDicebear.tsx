import { Avatar as DicebearAvatar, Style } from "@dicebear/core";
import pixelbotDefinition from "@dicebear/styles/pixelbot.json";
import planetsDefinition from "@dicebear/styles/planets.json";
import voxelBotDefinition from "@dicebear/styles/voxel-bot.json";
import { cn } from "obp-ui";
import { useMemo, useSyncExternalStore } from "react";
import { appPresetStyle } from "~/lib/theme";
import {
    type AvatarStyleId,
    type Frame,
    type Palette,
    hexOf,
    initialsMarkup,
    luminance,
    styleById,
} from "./avatarStyles";
import {
    SvgMarkup,
    TONE_KEYS,
    type ToneName,
    cleanDicebear,
    cyrb53,
    slugOf,
    toneToken,
} from "./modelIcons";

const DEFAULT_PX = 48;

const SINGLE_LETTER = "initials-single";

export type AvatarChoice = { style: AvatarStyleId; seed: string; tone: ToneName; letters?: string };

export const TONE_LABELS: Record<ToneName, string> = {
    csv: "Forest green",
    tsv: "Lagoon teal",
    json: "Honey amber",
    jsonl: "Ember orange",
    parquet: "Twilight indigo",
    avro: "Orchid purple",
    iceberg: "Iceberg blue",
    delta: "Moss lime",
    sql: "Berry pink",
    text: "Slate grey",
};

const DEFINITIONS: Record<Exclude<AvatarStyleId, "initials">, unknown> = {
    planets: planetsDefinition,
    "voxel-bot": voxelBotDefinition,
    pixelbot: pixelbotDefinition,
};

const STYLES = new Map<AvatarStyleId, Style>();

function styleOf(id: Exclude<AvatarStyleId, "initials">): Style {
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

export function baseSeed(name: string): string {
    return slugOf(name) || "model";
}

export function choiceFor(style: AvatarStyleId, name: string, seed = baseSeed(name)): AvatarChoice {
    return { style, seed, tone: toneAt(cyrb53(seed)) };
}

function randomHex(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomTone(except?: ToneName): ToneName {
    const pool = TONE_KEYS.filter((tone) => tone !== except);
    return pool[crypto.getRandomValues(new Uint32Array(1))[0] % pool.length];
}

export function rerollChoice(current: AvatarChoice, keepTone = false): AvatarChoice {
    return {
        ...current,
        seed: randomHex(),
        tone: keepTone ? current.tone : randomTone(current.tone),
    };
}

export function candidateChoices(
    style: AvatarStyleId,
    count: number,
    tone: ToneName | null,
    letters?: string,
): AvatarChoice[] {
    if (!styleById(style).seeded) {
        const extra = crypto.getRandomValues(new Uint32Array(1))[0];
        const single = [0, 5].map((step) => TONE_KEYS[(extra + step) % TONE_KEYS.length]);
        return [
            ...TONE_KEYS.map((key) => ({ style, seed: "initials", tone: key, letters })),
            ...single.map((key) => ({ style, seed: SINGLE_LETTER, tone: key, letters })),
        ].slice(0, count);
    }
    const offset = crypto.getRandomValues(new Uint32Array(1))[0];
    return Array.from({ length: count }, (_, index) => ({
        style,
        seed: randomHex(),
        tone: tone ?? TONE_KEYS[(offset + index) % TONE_KEYS.length],
    }));
}

export function sameChoice(one: AvatarChoice, two: AvatarChoice): boolean {
    const seeded = styleById(one.style).seeded;
    return (
        one.style === two.style &&
        one.tone === two.tone &&
        one.seed === two.seed &&
        (seeded || (one.letters ?? "") === (two.letters ?? ""))
    );
}

export function defaultLetters(name: string): string {
    const words = name
        .trim()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
    if (words.length === 0) {
        return "?";
    }
    if (words.length === 1) {
        return Array.from(words[0]).slice(0, 2).join("").toUpperCase();
    }
    return `${Array.from(words[0])[0]}${Array.from(words[1])[0]}`.toUpperCase();
}

export function lettersOf(choice: AvatarChoice, name: string): string {
    const text = choice.letters?.trim() || defaultLetters(name);
    return choice.seed === SINGLE_LETTER ? text.slice(0, 1) : text;
}

function framed(svg: string, frame: Frame, fill: string | null): string {
    const open = svg.indexOf(">") + 1;
    const close = svg.lastIndexOf("</svg>");
    const body = svg.slice(open, close).replace(/ clip-path="url\(#clip-[^)]*\)"/g, "");
    const viewBox = `${frame.x} ${frame.y} ${frame.size} ${frame.size}`;
    const backdrop = fill
        ? `<rect x="${frame.x}" y="${frame.y}" width="${frame.size}" height="${frame.size}" fill="${fill}"/>`
        : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none">${backdrop}${body}</svg>`;
}

export function avatarSvg(
    choice: AvatarChoice,
    name: string,
    palette: Palette,
    px = DEFAULT_PX,
): string {
    const style = styleById(choice.style);
    const tone = palette.tones[choice.tone] ?? palette.tones.csv;
    if (style.id === "initials") {
        return initialsMarkup(lettersOf(choice, name), palette, tone, px);
    }
    const svg = cleanDicebear(
        new DicebearAvatar(styleOf(style.id), {
            seed: choice.seed,
            idRandomization: true,
            ...style.options(palette, tone),
        }).toString(),
    );
    const painted = style.paint ? style.paint(svg, palette, tone, px) : svg;
    return framed(painted, style.frame, style.tile(palette, tone));
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

function useAvatarSvg(choice: AvatarChoice, name: string, px: number): string {
    const current = usePalette();
    const { style, seed, tone, letters } = choice;
    return useMemo(
        () => avatarSvg({ style, seed, tone, letters }, name, current, px),
        [style, seed, tone, letters, name, current, px],
    );
}

export type AvatarSize = "sm" | "md" | "lg" | "xl" | "hero" | "fill";

const AVATAR_TILE: Record<AvatarSize, string> = {
    sm: "size-5",
    md: "size-8",
    lg: "size-12",
    xl: "size-24",
    hero: "size-[calc(3rem*var(--hero-scale))] rounded-[calc((var(--radius)_-_2px)*var(--hero-scale))] border-[length:calc(1px*var(--hero-scale))]",
    fill: "size-full",
};

const AVATAR_PX: Record<AvatarSize, number> = {
    sm: 20,
    md: 32,
    lg: 48,
    xl: 96,
    hero: 120,
    fill: 40,
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
    const markup = useAvatarSvg(choice, name, AVATAR_PX[size]);
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
