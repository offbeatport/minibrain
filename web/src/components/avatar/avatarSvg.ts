import { useEffect, useSyncExternalStore } from "react";
import type { ModelAvatar } from "~/api/client";
import {
    type AvatarStyleId,
    type Frame,
    type Palette,
    type SeededStyleId,
    initialsMarkup,
    styleById,
} from "./avatarStyles";
import { TONE_KEYS, type ToneName, cyrb53, slugOf, toneOf } from "./tones";

const DEFAULT_PX = 48;

export const TWO_LETTERS = "initials";
export const ONE_LETTER = "one-letter";

export type AvatarChoice = { style: AvatarStyleId; seed: string; tone: ToneName; letters?: string };

export type Renderer = typeof import("./dicebear");

let renderer: Renderer | undefined;
let loading: Promise<Renderer> | undefined;
const waiting = new Set<() => void>();

export function loadDicebear(): Promise<Renderer> {
    loading ??= import("./dicebear").then((module) => {
        renderer = module;
        for (const listener of waiting) {
            listener();
        }
        return module;
    });
    return loading;
}

function onLoaded(listener: () => void): () => void {
    waiting.add(listener);
    return () => waiting.delete(listener);
}

export function useDicebear(needed: boolean): Renderer | undefined {
    const ready = useSyncExternalStore(onLoaded, () => renderer);
    useEffect(() => {
        if (needed && !ready) {
            void loadDicebear();
        }
    }, [needed, ready]);
    return ready;
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

export function fallbackChoice(name: string): AvatarChoice {
    return { style: "initials", seed: TWO_LETTERS, tone: toneOf(name.trim().toLowerCase()) };
}

export function choiceOfModel(avatar: ModelAvatar | null | undefined, name: string): AvatarChoice {
    if (!avatar) {
        return fallbackChoice(name);
    }
    const { style, seed, tone, letters } = avatar;
    return letters ? { style, seed, tone, letters } : { style, seed, tone };
}

export function avatarBody(choice: AvatarChoice): ModelAvatar {
    const { style, seed, tone, letters } = choice;
    return !styleById(style).seeded && letters
        ? { style, seed, tone, letters }
        : { style, seed, tone };
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

export function randomSeeds(count: number): string[] {
    return Array.from({ length: count }, () => randomHex());
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
    return choice.seed === ONE_LETTER ? (Array.from(text)[0] ?? text) : text;
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
    seeded: Renderer | undefined = renderer,
): string {
    const style = styleById(choice.style);
    const tone = palette.tones[choice.tone] ?? palette.tones.csv;
    if (style.id === "initials") {
        return initialsMarkup(lettersOf(choice, name), palette, tone, px);
    }
    const tile = style.tile(palette, tone);
    if (!seeded) {
        return framed("<svg></svg>", style.frame, tile);
    }
    const svg = seeded.renderSeeded(
        style.id as SeededStyleId,
        choice.seed,
        style.options(palette, tone),
    );
    const painted = style.paint ? style.paint(svg, palette, tone, px) : svg;
    return framed(painted, style.frame, tile);
}
