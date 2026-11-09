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

export type ContrastPair = { label: string; fg: string; bg: string; floor: number };

export type AvatarStyle = {
    id: AvatarStyleId;
    name: string;
    licence: string;
    options: (palette: Palette, tone: string) => Options;
    paint?: (svg: string, palette: Palette, tone: string) => string;
    pairs: (palette: Palette, tone: string) => ContrastPair[];
};

const LICENCE = "CC0 1.0";
const TEXT_FLOOR = 4.5;
const GRAPHIC_FLOOR = 3;
const INITIALS_TINT_WEIGHT = 0.14;
const LETTER_STEP = 0.05;
const RING_WEIGHT = 0.5;
const RING_GAP = 3;
const VOXEL_TILE_WEIGHT = 0.25;
const VOXEL_BODY_WEIGHT = 0.75;
const FACE_SCALE = 1.25;
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

function initialsTint(palette: Palette, tone: string): string {
    return mixHex(tone, palette.background, INITIALS_TINT_WEIGHT);
}

function lettersAtFloor(palette: Palette, tone: string): string {
    const tint = initialsTint(palette, tone);
    for (let share = 0; share <= 1; share += LETTER_STEP) {
        const letters = mixHex(tone, palette.foreground, 1 - share);
        if (contrast(letters, tint) >= TEXT_FLOOR) {
            return letters;
        }
    }
    return palette.foreground;
}

function ringInk(palette: Palette, tone: string): string {
    return mixHex(tone, palette.foreground, RING_WEIGHT);
}

function cutRings(svg: string, palette: Palette, tone: string): string {
    const ring = ringInk(palette, tone);
    return svg.replace(
        RING_PATTERN,
        (_match, attributes: string, width: string) =>
            `<ellipse ${attributes}stroke="${palette.background}" stroke-width="${Number(width) + RING_GAP}"/><ellipse ${attributes}stroke="${ring}" stroke-width="${width}"/>`,
    );
}

function voxelTile(palette: Palette, tone: string): string {
    return mixHex(tone, palette.surface, VOXEL_TILE_WEIGHT);
}

function voxelBody(palette: Palette, tone: string): string {
    return mixHex(tone, palette.paper, VOXEL_BODY_WEIGHT);
}

export const AVATAR_STYLES: AvatarStyle[] = [
    {
        id: "initials",
        name: "Initials",
        licence: LICENCE,
        options: (palette, tone) => ({
            initialsVariant: "alt",
            backgroundColor: [initialsTint(palette, tone)],
            textColor: [lettersAtFloor(palette, tone)],
            fontFamily: palette.font,
            fontWeight: 600,
        }),
        pairs: (palette, tone) => [
            {
                label: "letters on tint",
                fg: lettersAtFloor(palette, tone),
                bg: initialsTint(palette, tone),
                floor: TEXT_FLOOR,
            },
        ],
    },
    {
        id: "planets",
        name: "Planets",
        licence: LICENCE,
        options: (palette, tone) => ({
            backgroundColor: [],
            starProbability: 0,
            shadeVariant: "hard",
            planetColor: [tone],
            moonColor: [ringInk(palette, tone)],
        }),
        paint: cutRings,
        pairs: (palette, tone) => [
            { label: "planet on page", fg: tone, bg: palette.background, floor: GRAPHIC_FLOOR },
            {
                label: "rings on page",
                fg: ringInk(palette, tone),
                bg: palette.background,
                floor: GRAPHIC_FLOOR,
            },
        ],
    },
    {
        id: "voxel-bot",
        name: "Voxel Bot",
        licence: LICENCE,
        options: (palette, tone) => ({
            backgroundColor: [voxelTile(palette, tone)],
            bodyColor: [voxelBody(palette, tone)],
        }),
        pairs: (palette, tone) => [
            {
                label: "body on tile",
                fg: voxelBody(palette, tone),
                bg: voxelTile(palette, tone),
                floor: GRAPHIC_FLOOR,
            },
        ],
    },
    {
        id: "pixelbot",
        name: "Pixelbot",
        licence: LICENCE,
        options: (_palette, tone) => ({
            backgroundColor: [],
            glowColor: [tone],
            scale: FACE_SCALE,
        }),
        paint: (svg) => svg.replace(PIXEL_GRID_PATTERN, ""),
        pairs: (palette, tone) => [
            { label: "face on page", fg: tone, bg: palette.background, floor: GRAPHIC_FLOOR },
        ],
    },
];

const STYLE_BY_ID = new Map(AVATAR_STYLES.map((style) => [style.id, style]));

export function styleById(id: AvatarStyleId): AvatarStyle {
    return STYLE_BY_ID.get(id) ?? AVATAR_STYLES[0];
}
