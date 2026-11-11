import { avatarSvg } from "./avatarDicebear";
import { type AvatarStyle, type ContrastPair, type Palette, contrast, hexOf } from "./avatarStyles";
import { TONE_KEYS, type ToneName } from "./modelIcons";

export const RENDER_SIZES = [176, 20] as const;

export type RenderSize = (typeof RENDER_SIZES)[number];

export type Lowest = { value: number; tone: ToneName };

const HERO_BORDER = 176 / 48;
const SEEDS = ["north", "ember", "quill", "tidal", "lumen", "orbit"];
const SAMPLE_NAME = "Weather Model";
const ON_LINE = 18;

type Rgb = [number, number, number];

function rgbOf(hex: string): Rgb {
    return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as Rgb;
}

function artSize(size: RenderSize): number {
    const border = size === 20 ? 1 : HERO_BORDER;
    return Math.round(size - 2 * border);
}

async function rasterise(svg: string, size: number, backdrop: string): Promise<Uint8ClampedArray> {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
        const image = new Image(size, size);
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
            return new Uint8ClampedArray();
        }
        context.fillStyle = backdrop;
        context.fillRect(0, 0, size, size);
        context.drawImage(image, 0, 0, size, size);
        return context.getImageData(0, 0, size, size).data;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function peakContrast(pixels: Uint8ClampedArray, pair: ContrastPair): number {
    const fg = rgbOf(pair.fg);
    const bg = rgbOf(pair.bg);
    const span = fg.map((value, index) => value - bg[index]);
    const length = span.reduce((sum, value) => sum + value * value, 0);
    let best = 1;
    for (let offset = 0; offset < pixels.length; offset += 4) {
        const pixel: Rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
        const away = pixel.map((value, index) => value - bg[index]);
        const share = away.reduce((sum, value, index) => sum + value * span[index], 0) / length;
        if (share <= 0 || length === 0) {
            continue;
        }
        const residual = Math.hypot(...away.map((value, index) => value - share * span[index]));
        if (residual <= ON_LINE) {
            best = Math.max(best, contrast(hexOf(pixel), pair.bg));
        }
    }
    return best;
}

export type RenderedRow = {
    label: string;
    floor: number;
    lowest: Record<RenderSize, Lowest>;
};

export async function measureRendered(
    style: AvatarStyle,
    palette: Palette,
): Promise<RenderedRow[]> {
    const pairsFor = (tone: ToneName) => style.pairs(palette, palette.tones[tone]);
    const rows: RenderedRow[] = pairsFor("csv").map((pair) => ({
        label: pair.label,
        floor: pair.floor,
        lowest: {
            176: { value: Number.POSITIVE_INFINITY, tone: "csv" },
            20: { value: Number.POSITIVE_INFINITY, tone: "csv" },
        },
    }));
    const seeds = style.seeded ? SEEDS : ["initials"];
    for (const tone of TONE_KEYS) {
        const pairs = pairsFor(tone);
        for (const seed of seeds) {
            for (const size of RENDER_SIZES) {
                const svg = avatarSvg({ style: style.id, seed, tone }, SAMPLE_NAME, palette, size);
                const markup = svg.toLowerCase();
                const pixels = await rasterise(svg, artSize(size), palette.background);
                pairs.forEach((pair, index) => {
                    if (!markup.includes((pair.mark ?? pair.fg).toLowerCase())) {
                        return;
                    }
                    const value = peakContrast(pixels, pair);
                    if (value < rows[index].lowest[size].value) {
                        rows[index].lowest[size] = { value, tone };
                    }
                });
            }
        }
    }
    return rows;
}
