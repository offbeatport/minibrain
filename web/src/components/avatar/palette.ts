import { useSyncExternalStore } from "react";
import { appPresetStyle } from "~/lib/theme";
import { type Palette, hexOf, luminance } from "./avatarStyles";
import { TONE_KEYS, type ToneName, toneToken } from "./tones";

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

function readableRules(sheet: CSSStyleSheet): CSSRuleList | undefined {
    try {
        return sheet.cssRules;
    } catch {
        return undefined;
    }
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
        refresh();
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
