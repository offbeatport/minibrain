import {
    type AvatarStyleId,
    type ContrastPair,
    type FramedVariant,
    type Palette,
    contrast,
    mixHex,
    styleById,
} from "./avatarDicebear";

const TEXT_FLOOR = 4.5;
const GRAPHIC_FLOOR = 3;
const PIXEL_OFF_WEIGHT = 0.14;
const INITIALS_TINT_WEIGHT = 0.14;
const RING_WEIGHT = 0.5;
const RING_GAP = 3;
const STEP = 0.05;
const FACE_SCALE = 1.25;
const RING_PATTERN =
    /<ellipse ([^>]*?)stroke="#fff" stroke-opacity="[^"]*" stroke-width="([\d.]+)"\/>/g;
const PIXEL_GRID_PATTERN = /<g fill="#000000" fill-opacity="\.4">[\s\S]*?<\/g>/;

function ringInk(palette: Palette, tone: string): string {
    return mixHex(tone, palette.foreground, RING_WEIGHT);
}

function pixelOff(palette: Palette, tone: string): string {
    return mixHex(tone, palette.background, PIXEL_OFF_WEIGHT);
}

function initialsTint(palette: Palette, tone: string): string {
    return mixHex(tone, palette.background, INITIALS_TINT_WEIGHT);
}

function lettersAtFloor(palette: Palette, tone: string): string {
    const tint = initialsTint(palette, tone);
    for (let share = 0; share <= 1; share += STEP) {
        const letters = mixHex(tone, palette.foreground, 1 - share);
        if (contrast(letters, tint) >= TEXT_FLOOR) {
            return letters;
        }
    }
    return palette.foreground;
}

function cutRings(svg: string, palette: Palette, tone: string): string {
    const ring = ringInk(palette, tone);
    return svg.replace(
        RING_PATTERN,
        (_match, attributes: string, width: string) =>
            `<ellipse ${attributes}stroke="${palette.background}" stroke-width="${Number(width) + RING_GAP}"/><ellipse ${attributes}stroke="${ring}" stroke-width="${width}"/>`,
    );
}

function solidLetters(palette: Palette, tone: string): string {
    return contrast(palette.paper, tone) >= contrast(palette.ink, tone)
        ? palette.paper
        : palette.ink;
}

function planetsVariant(id: string, label: string, shade: "hard" | "soft", how: string) {
    return {
        id,
        style: "planets",
        label,
        how,
        options: (palette, tone) => ({
            backgroundColor: [],
            starProbability: 0,
            shadeVariant: shade,
            planetColor: [tone],
            moonColor: [ringInk(palette, tone)],
        }),
        paint: cutRings,
        pairs: (palette, tone) => [
            { label: "Planet on page", fg: tone, bg: palette.background, floor: GRAPHIC_FLOOR },
            {
                label: "Ring and moons on page",
                fg: ringInk(palette, tone),
                bg: palette.background,
                floor: GRAPHIC_FLOOR,
            },
        ],
    } satisfies FramedVariant;
}

export const FRAMED_VARIANTS: FramedVariant[] = [
    {
        id: "initials-tint",
        style: "initials",
        label: "Framed, tint fill",
        how: "DiceBear options only: backgroundColor is the tone mixed 14% into --background, textColor is the full tone. The solid version above stays for comparison.",
        options: (palette, tone) => ({
            initialsVariant: "alt",
            backgroundColor: [initialsTint(palette, tone)],
            textColor: [tone],
            fontFamily: palette.font,
            fontWeight: 600,
        }),
        pairs: (palette, tone) => [
            {
                label: "Letters on tint",
                fg: tone,
                bg: initialsTint(palette, tone),
                floor: TEXT_FLOOR,
            },
            {
                label: "Solid, for comparison: letters on tone",
                fg: solidLetters(palette, tone),
                bg: tone,
                floor: TEXT_FLOOR,
            },
        ],
    },
    {
        id: "initials-tint-stepped",
        style: "initials",
        picked: true,
        label: "Framed, tint fill, letters stepped to 4.5:1",
        how: "As the tint fill, but the letters move from the tone towards --foreground in 5% steps until they reach 4.5:1 on the tint. Tones that already pass keep the full tone.",
        options: (palette, tone) => ({
            initialsVariant: "alt",
            backgroundColor: [initialsTint(palette, tone)],
            textColor: [lettersAtFloor(palette, tone)],
            fontFamily: palette.font,
            fontWeight: 600,
        }),
        pairs: (palette, tone) => [
            {
                label: "Letters on tint",
                fg: lettersAtFloor(palette, tone),
                bg: initialsTint(palette, tone),
                floor: TEXT_FLOOR,
            },
        ],
    },
    {
        id: "waves-clipped",
        style: "waves",
        label: "Framed, background kept",
        how: "No change to the SVG: the waves are the image, so the tone background stays and the tile clips it inside the 1px border with the same corners as a publisher logo.",
        options: (palette, tone) => styleById("waves").options(palette, tone),
        pairs: (palette, tone) => [
            { label: "Tile on page", fg: tone, bg: palette.background, floor: GRAPHIC_FLOOR },
        ],
    },
    planetsVariant(
        "planets-flat",
        "Framed, no sky, flat shade",
        "hard",
        'DiceBear options: backgroundColor [] drops the sky rect, starProbability 0 drops the stars, shadeVariant "hard" swaps the radial gradient for two flat crescents. Post-process: the rings are white strokes at 35-55% opacity, invisible on a light page, so each ring is redrawn opaque in the tone stepped halfway to --foreground, over a wider stroke in --background. That gap cuts the ring out where it crosses the planet, so it reads against the page colour everywhere (the ring drawn straight on the planet measured 1.1-1.9:1).',
    ),
    planetsVariant(
        "planets-gradient",
        "Framed, no sky, gradient shade",
        "soft",
        'As the flat version, but with DiceBear\'s default shadeVariant "soft": a radial gradient from 14% white to 26% black over the disc.',
    ),
    {
        id: "pixelbot-bare",
        style: "pixelbot",
        label: "Framed, no background, unlit pixels tinted",
        how: 'DiceBear option backgroundColor [] drops the ground rect; glowColor is the full tone. Post-process: the unlit pixel grid is drawn by the style as black at 40% opacity, so its fill="#000000" fill-opacity=".4" group is repainted flat as the tone mixed 14% into --background.',
        options: (_palette, tone) => ({
            backgroundColor: [],
            glowColor: [tone],
        }),
        paint: (svg, palette, tone) =>
            svg.replace('fill="#000000" fill-opacity=".4"', `fill="${pixelOff(palette, tone)}"`),
        pairs: (palette, tone) => [
            { label: "Face on page", fg: tone, bg: palette.background, floor: GRAPHIC_FLOOR },
            {
                label: "Face on unlit pixels",
                fg: tone,
                bg: pixelOff(palette, tone),
                floor: GRAPHIC_FLOOR,
            },
        ],
    },
    {
        id: "pixelbot-face",
        style: "pixelbot",
        picked: true,
        label: "Framed, no background, face only",
        how: 'DiceBear option backgroundColor [] drops the ground rect; glowColor is the full tone. Post-process: the fill="#000000" fill-opacity=".4" group that draws the unlit pixel grid is removed, so only the lit eyes and mouth remain on the tile. DiceBear option scale 1.25 grows the face to fill the space the grid left.',
        options: (_palette, tone) => ({
            backgroundColor: [],
            glowColor: [tone],
            scale: FACE_SCALE,
        }),
        paint: (svg) => svg.replace(PIXEL_GRID_PATTERN, ""),
        pairs: (palette, tone) => [
            { label: "Face on page", fg: tone, bg: palette.background, floor: GRAPHIC_FLOOR },
        ],
    },
];

const CLIPPED = new Map<AvatarStyleId, FramedVariant>();

function clippedVariant(id: AvatarStyleId): FramedVariant {
    const cached = CLIPPED.get(id);
    if (cached) {
        return cached;
    }
    const style = styleById(id);
    const variant: FramedVariant = {
        id: `${id}-clipped`,
        style: id,
        label: "Framed, background kept",
        how: "Clipped to the tile",
        options: style.options,
        pairs: (): ContrastPair[] => [],
    };
    CLIPPED.set(id, variant);
    return variant;
}

export function framedVariantsOf(id: AvatarStyleId): FramedVariant[] {
    return FRAMED_VARIANTS.filter((variant) => variant.style === id);
}

export function framedFor(id: AvatarStyleId): FramedVariant {
    const variants = framedVariantsOf(id);
    return variants.find((variant) => variant.picked) ?? variants[0] ?? clippedVariant(id);
}
