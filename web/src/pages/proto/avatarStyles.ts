import type { ToneName } from "./modelIcons";

export type AvatarStyleId = "initials" | "planets" | "voxel-bot" | "pixelbot";

export type Palette = {
    tones: Record<ToneName, string>;
    background: string;
    foreground: string;
    surface: string;
    paper: string;
    ink: string;
    font: string;
};

export type Options = Record<string, unknown>;

export type ContrastPair = { label: string; fg: string; bg: string; floor: number; mark?: string };

export type Frame = { x: number; y: number; size: number };

export type AvatarStyle = {
    id: AvatarStyleId;
    name: string;
    licence: string;
    seeded: boolean;
    frame: Frame;
    tile: (palette: Palette, tone: string) => string | null;
    options: (palette: Palette, tone: string) => Options;
    paint?: (svg: string, palette: Palette, tone: string, px: number) => string;
    pairs: (palette: Palette, tone: string) => ContrastPair[];
};

export const TEXT_FLOOR = 4.5;
export const GRAPHIC_FLOOR = 3;
const LICENCE = "CC0 1.0";
const TINT_WEIGHT = 0.14;
const LADDER_STEP = 0.05;
const RING_WEIGHT = 0.5;
const RING_GAP = 3;
const RING_MIN_PX = 1.25;
const PLANET_FRAME = 110;
const SMALL_LETTERS_PX = 24;
const VOXEL_BODY_WEIGHT = 0.75;
const RING_PATTERN =
    /<ellipse ([^>]*?)stroke="#fff" stroke-opacity="[^"]*" stroke-width="([\d.]+)"\/>/g;
const PIXEL_GRID_PATTERN = /<g fill="#000000" fill-opacity="\.4">[\s\S]*?<\/g>/;

function channels(hex: string): number[] {
    return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

export function hexOf(values: ArrayLike<number>): string {
    return `#${Array.from(values, (value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function mixHex(color: string, other: string, weight: number): string {
    const right = channels(other);
    return hexOf(
        channels(color).map((value, index) => value * weight + right[index] * (1 - weight)),
    );
}

export function luminance(hex: string): number {
    const [red, green, blue] = channels(hex).map((value) => {
        const unit = value / 255;
        return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrast(one: string, two: string): number {
    const [dark, light] = [luminance(one), luminance(two)].sort((a, b) => a - b);
    return (light + 0.05) / (dark + 0.05);
}

function towardFloor(start: string, target: string, against: string, floor: number): string {
    for (let share = 0; share <= 1; share += LADDER_STEP) {
        const candidate = mixHex(target, start, share);
        if (contrast(candidate, against) >= floor) {
            return candidate;
        }
    }
    return target;
}

function tint(palette: Palette, tone: string): string {
    return mixHex(tone, palette.background, TINT_WEIGHT);
}

function letters(palette: Palette, tone: string): string {
    return towardFloor(tone, palette.foreground, tint(palette, tone), TEXT_FLOOR);
}

function ringInk(palette: Palette, tone: string): string {
    return mixHex(tone, palette.foreground, RING_WEIGHT);
}

function cutRings(svg: string, palette: Palette, tone: string, px: number): string {
    const ring = ringInk(palette, tone);
    const floor = (RING_MIN_PX * PLANET_FRAME) / Math.max(px - 2, 1);
    let index = 0;
    return svg.replace(RING_PATTERN, (_match, attributes: string, width: string) => {
        const drawn = Math.max(Number(width), floor);
        const thickened = drawn > Number(width);
        index += 1;
        if (thickened && index > 1) {
            return "";
        }
        return `<ellipse ${attributes}stroke="${palette.background}" stroke-width="${drawn + RING_GAP}"/><ellipse ${attributes}stroke="${ring}" stroke-width="${drawn}"/>`;
    });
}

function voxelBody(palette: Palette, tone: string): string {
    return towardFloor(
        mixHex(tone, palette.paper, VOXEL_BODY_WEIGHT),
        palette.ink,
        tint(palette, tone),
        GRAPHIC_FLOOR,
    );
}

export function initialsMarkup(text: string, palette: Palette, tone: string, px = 48): string {
    const size = text.length > 1 ? 44 : 54;
    const weight = px <= SMALL_LETTERS_PX ? 700 : 600;
    const escaped = text.replace(/[<>&"]/g, "");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${tint(palette, tone)}"/><text x="50" y="50" dy="0.35em" text-anchor="middle" font-family="${palette.font}" font-weight="${weight}" font-size="${size}" letter-spacing="-0.5" fill="${letters(palette, tone)}">${escaped}</text></svg>`;
}

export const AVATAR_STYLES: AvatarStyle[] = [
    {
        id: "initials",
        name: "Initials",
        licence: "Built in",
        seeded: false,
        frame: { x: 0, y: 0, size: 100 },
        tile: tint,
        options: () => ({}),
        pairs: (palette, tone) => [
            {
                label: "Letters on tint",
                fg: letters(palette, tone),
                bg: tint(palette, tone),
                floor: TEXT_FLOOR,
            },
        ],
    },
    {
        id: "planets",
        name: "Planets",
        licence: LICENCE,
        seeded: true,
        frame: { x: -5, y: -5, size: PLANET_FRAME },
        tile: () => null,
        options: (palette, tone) => ({
            backgroundColor: [],
            starProbability: 0,
            shadeVariant: "hard",
            planetColor: [tone],
            moonColor: [ringInk(palette, tone)],
        }),
        paint: cutRings,
        pairs: (palette, tone) => [
            { label: "Planet on page", fg: tone, bg: palette.background, floor: GRAPHIC_FLOOR },
            {
                label: "Rings on page",
                fg: ringInk(palette, tone),
                bg: palette.background,
                floor: GRAPHIC_FLOOR,
                mark: `stroke="${ringInk(palette, tone)}"`,
            },
        ],
    },
    {
        id: "voxel-bot",
        name: "Voxel Bot",
        licence: LICENCE,
        seeded: true,
        frame: { x: -4.5, y: -3.5, size: 136 },
        tile: tint,
        options: (palette, tone) => ({
            backgroundColor: [],
            bodyColor: [voxelBody(palette, tone)],
        }),
        pairs: (palette, tone) => [
            {
                label: "Body on tint",
                fg: voxelBody(palette, tone),
                bg: tint(palette, tone),
                floor: GRAPHIC_FLOOR,
            },
        ],
    },
    {
        id: "pixelbot",
        name: "Pixelbot",
        licence: LICENCE,
        seeded: true,
        frame: { x: 8, y: 12.2, size: 84 },
        tile: () => null,
        options: (_palette, tone) => ({
            backgroundColor: [],
            glowColor: [tone],
        }),
        paint: (svg) => svg.replace(PIXEL_GRID_PATTERN, ""),
        pairs: (palette, tone) => [
            { label: "Face on page", fg: tone, bg: palette.background, floor: GRAPHIC_FLOOR },
        ],
    },
];

const STYLE_BY_ID = new Map(AVATAR_STYLES.map((style) => [style.id, style]));

export function styleById(id: AvatarStyleId): AvatarStyle {
    return STYLE_BY_ID.get(id) ?? AVATAR_STYLES[0];
}
