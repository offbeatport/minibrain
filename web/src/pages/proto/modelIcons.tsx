import { Avatar as DicebearAvatar, Style } from "@dicebear/core";
import identiconDefinition from "@dicebear/styles/identicon.json";
import shapesDefinition from "@dicebear/styles/shapes.json";
import Avatar from "boring-avatars";
import { toSvg } from "jdenticon";
import {
    Database,
    FileSearch,
    type LucideIcon,
    MessageSquareText,
    ScanText,
    Tags,
} from "lucide-react";
import { minidenticon } from "minidenticons";
import { type ProviderId, ProviderLogo, cn } from "obp-ui";
import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useRef } from "react";

export type Size = "sm" | "md" | "lg";
export type Task = "classify" | "extract" | "chat" | "review" | "sql";

export type SampleModel = {
    name: string;
    publisher: string;
    base: string;
    task: Task;
    version: number;
};

export const MODELS: SampleModel[] = [
    { name: "Support triage", publisher: "Qwen", base: "Qwen3 0.6B", task: "classify", version: 4 },
    {
        name: "Invoice extractor",
        publisher: "Google",
        base: "Gemma 3 1B",
        task: "extract",
        version: 2,
    },
    { name: "guy1", publisher: "Meta", base: "Llama 3.2 1B", task: "chat", version: 1 },
    { name: "Assistant 1", publisher: "Qwen", base: "Qwen3 4B", task: "chat", version: 7 },
    {
        name: "Contract reviewer",
        publisher: "Mistral AI",
        base: "Ministral 8B",
        task: "review",
        version: 3,
    },
    { name: "SQL helper", publisher: "Microsoft", base: "Phi-4 mini", task: "sql", version: 5 },
];

export const PIXELS: Record<Size, number> = { sm: 20, md: 32, lg: 48 };

const TILE: Record<Size, string> = { sm: "size-5", md: "size-8", lg: "size-12" };
const LOGO: Record<Size, string> = { sm: "size-3.5", md: "size-5", lg: "size-7" };
const ONE_LETTER: Record<Size, string> = { sm: "text-sm", md: "text-lg", lg: "text-3xl" };
const TWO_LETTERS: Record<Size, string> = { sm: "text-sm", md: "text-sm", lg: "text-xl" };
const STROKE: Record<Size, number> = { sm: 2.6, md: 2, lg: 1.6 };

const PROVIDERS: Record<string, ProviderId> = {
    Qwen: "qwen",
    Google: "google",
    Meta: "meta",
    "Mistral AI": "mistral",
    Microsoft: "microsoft",
};

export const TONE_KEYS = [
    "csv",
    "tsv",
    "json",
    "jsonl",
    "parquet",
    "avro",
    "iceberg",
    "delta",
    "sql",
    "text",
] as const;

export type ToneName = (typeof TONE_KEYS)[number];

export function toneToken(name: ToneName): string {
    return `--file-${name}`;
}

export const TONE_TOKENS = TONE_KEYS.map(toneToken);

const TONES = TONE_TOKENS.map((token) => `var(${token})`);

const TASK_GLYPHS: Record<Task, LucideIcon> = {
    classify: Tags,
    extract: ScanText,
    chat: MessageSquareText,
    review: FileSearch,
    sql: Database,
};

export function slugOf(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

export function cyrb53(text: string, seed = 0): number {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function stream(name: string, salt: string): () => number {
    let state = cyrb53(`${salt}:${slugOf(name)}`) >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<T>(next: () => number, choices: readonly T[]): T {
    return choices[Math.floor(next() * choices.length)];
}

export function toneOf(name: string, offset = 0): string {
    return TONES[(cyrb53(slugOf(name)) + offset) % TONES.length];
}

function mix(color: string, percent: number): string {
    return `color-mix(in srgb, ${color} ${percent}%, var(--card))`;
}

export function initials(name: string, count: 1 | 2): string {
    const words = name
        .trim()
        .split(/[\s_-]+/)
        .filter(Boolean);
    const first = words[0]?.[0] ?? "?";
    if (count === 1) {
        return first.toUpperCase();
    }
    if (words.length > 1) {
        return `${first}${words[1][0]}`.toUpperCase();
    }
    const digit = words[0].match(/\d/)?.[0];
    return `${first}${digit ?? words[0][1] ?? ""}`.toUpperCase();
}

function Tile({
    size,
    className,
    style,
    children,
}: {
    size: Size;
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
}) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                "relative flex shrink-0 items-center justify-center overflow-hidden rounded-md",
                TILE[size],
                className,
            )}
            style={style}
        >
            {children}
        </span>
    );
}

function softTile(name: string): CSSProperties {
    const tone = toneOf(name);
    return {
        backgroundColor: mix(tone, 14),
        borderColor: mix(tone, 40),
        color: `color-mix(in srgb, ${tone} 75%, var(--foreground))`,
    };
}

function Glyph({ size, children }: { size: Size; children: ReactNode }) {
    const inset = size === "sm" ? 2 : size === "md" ? 4 : 6;
    const side = PIXELS[size] - inset * 2;
    return (
        <svg width={side} height={side} viewBox="0 0 24 24" aria-hidden="true">
            {children}
        </svg>
    );
}

export function SvgMarkup({ markup }: { markup: string }) {
    const host = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        host.current?.replaceChildren(svg);
    }, [markup]);
    return <span ref={host} className="flex size-full" />;
}

function placeholders(colors: string[]): { hexes: string[]; paint: (svg: string) => string } {
    const hexes = colors.map((_, index) => `f0f0${index.toString(16).padStart(2, "0")}`);
    return {
        hexes,
        paint: (svg) =>
            hexes.reduce(
                (painted, hex, index) => painted.replaceAll(`#${hex}`, colors[index]),
                svg,
            ),
    };
}

export function cleanDicebear(svg: string): string {
    return svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<metadata[\s\S]*?<\/metadata>/, "");
}

let shapesStyle: Style<typeof shapesDefinition> | undefined;
let identiconStyle: Style<typeof identiconDefinition> | undefined;

function MonoMonogram({ model, size }: { model: SampleModel; size: Size }) {
    const two = size !== "sm";
    return (
        <Tile size={size} className="border bg-background">
            <span
                className={cn(
                    "font-semibold text-muted-foreground",
                    two ? TWO_LETTERS[size] : ONE_LETTER[size],
                )}
            >
                {initials(model.name, two ? 2 : 1)}
            </span>
        </Tile>
    );
}

function TintedMonogram({ model, size }: { model: SampleModel; size: Size }) {
    const two = size !== "sm";
    return (
        <Tile size={size} className="border" style={softTile(model.name)}>
            <span className={cn("font-semibold", two ? TWO_LETTERS[size] : ONE_LETTER[size])}>
                {initials(model.name, two ? 2 : 1)}
            </span>
        </Tile>
    );
}

function SolidMonogram({ model, size }: { model: SampleModel; size: Size }) {
    return (
        <Tile size={size} style={{ backgroundColor: toneOf(model.name), color: "var(--card)" }}>
            <span className={cn("font-semibold", ONE_LETTER[size])}>{initials(model.name, 1)}</span>
        </Tile>
    );
}

function TaskGlyph({ model, size }: { model: SampleModel; size: Size }) {
    const Icon = TASK_GLYPHS[model.task];
    return (
        <Tile size={size} className="border" style={softTile(model.name)}>
            <Icon className={LOGO[size]} strokeWidth={size === "sm" ? 2.5 : 2} />
        </Tile>
    );
}

function BaseLogo({ model, size }: { model: SampleModel; size: Size }) {
    const id = PROVIDERS[model.publisher];
    return id ? <ProviderLogo id={id} className={LOGO[size]} /> : null;
}

function NotchedBase({ model, size }: { model: SampleModel; size: Size }) {
    const notch = { sm: 8, md: 11, lg: 16 }[size];
    return (
        <Tile size={size} className="border bg-background">
            <BaseLogo model={model} size={size} />
            <svg
                className="absolute right-0 bottom-0"
                width={notch}
                height={notch}
                viewBox="0 0 10 10"
                aria-hidden="true"
            >
                <path d="M10 0V10H0Z" fill={toneOf(model.name)} />
            </svg>
        </Tile>
    );
}

function TintedBase({ model, size }: { model: SampleModel; size: Size }) {
    return (
        <Tile size={size} className="border" style={softTile(model.name)}>
            <BaseLogo model={model} size={size} />
        </Tile>
    );
}

function BadgedMonogram({ model, size }: { model: SampleModel; size: Size }) {
    const id = PROVIDERS[model.publisher];
    const badge = { sm: "size-3", md: "size-4", lg: "size-6" }[size];
    const logo = { sm: "size-2", md: "size-3", lg: "size-4" }[size];
    return (
        <span aria-hidden="true" className={cn("relative flex shrink-0", TILE[size])}>
            <Tile size={size} className="border" style={softTile(model.name)}>
                <span className={cn("font-semibold", ONE_LETTER[size])}>
                    {initials(model.name, 1)}
                </span>
            </Tile>
            {id && (
                <span
                    className={cn(
                        "absolute -right-1 -bottom-1 flex items-center justify-center rounded-sm border bg-card",
                        badge,
                    )}
                >
                    <ProviderLogo id={id} className={logo} />
                </span>
            )}
        </span>
    );
}

function ForkMark({ model, size }: { model: SampleModel; size: Size }) {
    const next = stream(model.name, "fork");
    const side = next() < 0.5 ? -1 : 1;
    const split = pick(next, [13, 15, 17]);
    const tone = toneOf(model.name);
    const x = 12 - side * 4;
    const tip = 12 + side * 5;
    const stroke = STROKE[size];
    return (
        <Tile size={size} className="border bg-background">
            <Glyph size={size}>
                <path
                    d={`M${x} 20 V4`}
                    stroke="var(--border)"
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    fill="none"
                />
                <path
                    d={`M${x} ${split} C${x} ${split - 5} ${tip} ${split - 3} ${tip} 7`}
                    stroke={tone}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    fill="none"
                />
                <circle
                    cx={x}
                    cy={20}
                    r={2.4}
                    fill="var(--background)"
                    stroke="var(--muted-foreground)"
                    strokeWidth={stroke * 0.75}
                />
                <circle cx={tip} cy={6} r={3.4} fill={tone} />
            </Glyph>
        </Tile>
    );
}

function arc(radius: number, start: number, sweep: number): string {
    const point = (degrees: number) => {
        const radians = ((degrees - 90) * Math.PI) / 180;
        return `${(12 + radius * Math.cos(radians)).toFixed(2)} ${(12 + radius * Math.sin(radians)).toFixed(2)}`;
    };
    return `M${point(start)} A${radius} ${radius} 0 ${sweep > 180 ? 1 : 0} 1 ${point(start + sweep)}`;
}

function Arcs({ model, size }: { model: SampleModel; size: Size }) {
    const next = stream(model.name, "arcs");
    const tone = toneOf(model.name);
    const stroke = STROKE[size] * 1.15;
    const rings = [9, 5.5].map((radius) => ({
        radius,
        start: pick(next, [0, 45, 90, 135, 180, 225, 270, 315]),
        sweep: pick(next, [90, 180, 270]),
    }));
    return (
        <Tile size={size} style={{ backgroundColor: mix(tone, 14) }}>
            <Glyph size={size}>
                {rings.map((ring) => (
                    <path
                        key={ring.radius}
                        d={arc(ring.radius, ring.start, ring.sweep)}
                        stroke={tone}
                        strokeWidth={stroke}
                        fill="none"
                    />
                ))}
                <circle cx={12} cy={12} r={2} fill={tone} />
            </Glyph>
        </Tile>
    );
}

function Facets({ model, size }: { model: SampleModel; size: Size }) {
    const next = stream(model.name, "facets");
    const tone = toneOf(model.name);
    const levels = [100, 70, 45, 22];
    const triangles: { d: string; fill: string }[] = [];
    for (const [cx, cy] of [
        [0, 0],
        [12, 0],
        [0, 12],
        [12, 12],
    ]) {
        const right = cx + 12;
        const bottom = cy + 12;
        const halves =
            next() < 0.5
                ? [`M${cx} ${cy}H${right}V${bottom}Z`, `M${cx} ${cy}V${bottom}H${right}Z`]
                : [`M${cx} ${cy}H${right}L${cx} ${bottom}Z`, `M${right} ${cy}V${bottom}H${cx}Z`];
        for (const d of halves) {
            triangles.push({ d, fill: mix(tone, pick(next, levels)) });
        }
    }
    return (
        <Tile size={size}>
            <svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden="true">
                {triangles.map((triangle) => (
                    <path key={triangle.d} d={triangle.d} fill={triangle.fill} />
                ))}
            </svg>
        </Tile>
    );
}

type Point = [number, number];

function branches(name: string): { d: string; tips: Point[] } {
    const next = stream(name, "branches");
    const form = pick(next, ["tree", "fork", "radial"] as const);
    const arms = { tree: [0], fork: [-0.55, 0.55], radial: [0, 2.094, -2.094] }[form];
    const levels = form === "tree" ? pick(next, [2, 3]) : pick(next, [1, 2]);
    const split = form === "tree" && levels === 2 ? pick(next, [2, 3]) : 2;
    const spread = pick(next, [0.42, 0.55, 0.68, 0.8]);
    const ratio = pick(next, [0.62, 0.72]);
    const segments: [Point, Point][] = [];
    const tips: Point[] = [];
    const grow = (start: Point, heading: number, length: number, level: number) => {
        const end: Point = [
            start[0] + length * Math.sin(heading),
            start[1] - length * Math.cos(heading),
        ];
        segments.push([start, end]);
        if (level === levels) {
            tips.push(end);
            return;
        }
        const turns = split === 3 ? [-spread, 0, spread] : [-spread, spread];
        for (const turn of turns) {
            grow(end, heading + turn, length * ratio, level + 1);
        }
    };
    for (const arm of arms) {
        grow([0, 0], arm, 1, 0);
    }
    const points = segments.flat();
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const scale =
        16 / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const place = ([x, y]: Point): Point => [12 + (x - midX) * scale, 12 + (y - midY) * scale];
    const at = (point: Point) => {
        const [x, y] = place(point);
        return `${x.toFixed(2)} ${y.toFixed(2)}`;
    };
    return {
        d: segments.map(([start, end]) => `M${at(start)}L${at(end)}`).join(""),
        tips: tips.map(place),
    };
}

function BranchMark({ model, size }: { model: SampleModel; size: Size }) {
    const shape = branches(model.name);
    const stroke = STROKE[size];
    return (
        <Tile size={size} style={{ backgroundColor: toneOf(model.name) }}>
            <Glyph size={size}>
                <path
                    d={shape.d}
                    stroke="var(--card)"
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    fill="none"
                />
                {shape.tips.map(([x, y]) => (
                    <circle key={`${x}-${y}`} cx={x} cy={y} r={stroke * 0.95} fill="var(--card)" />
                ))}
            </Glyph>
        </Tile>
    );
}

const SHAPES = {
    circle: "M12 1.5a10.5 10.5 0 1 0 0 21a10.5 10.5 0 1 0 0-21Z",
    hexagon: "M12 1 21.5 6.5V17.5L12 23 2.5 17.5V6.5Z",
    diamond: "M12 0.5 23.5 12 12 23.5 0.5 12Z",
    octagon: "M7.5 1.5H16.5L22.5 7.5V16.5L16.5 22.5H7.5L1.5 16.5V7.5Z",
    shield: "M3 2H21V12C21 17 17 21 12 23C7 21 3 17 3 12Z",
};

function LetterInShape({ model, size }: { model: SampleModel; size: Size }) {
    const next = stream(model.name, "shape");
    const shape = pick(next, Object.values(SHAPES));
    return (
        <Tile size={size} className="border bg-background">
            <Glyph size={size}>
                <path d={shape} fill={toneOf(model.name)} />
            </Glyph>
            <span
                className={cn(
                    "absolute inset-0 flex items-center justify-center font-semibold",
                    size === "lg" ? "text-xl" : "text-sm",
                )}
                style={{ color: "var(--card)" }}
            >
                {initials(model.name, 1)}
            </span>
        </Tile>
    );
}

function DotMatrix({ model, size }: { model: SampleModel; size: Size }) {
    const next = stream(model.name, "dots");
    const tone = toneOf(model.name);
    const half = Array.from({ length: 8 }, () => next() < 0.55);
    const lit = Array.from({ length: 16 }, (_, index) => {
        const row = Math.floor(index / 4);
        const column = index % 4;
        return half[row * 2 + (column < 2 ? column : 3 - column)];
    });
    return (
        <Tile size={size} className="border bg-background">
            <Glyph size={size}>
                {lit.map((on, index) => (
                    <circle
                        key={`${index}-${on}`}
                        cx={3 + (index % 4) * 6}
                        cy={3 + Math.floor(index / 4) * 6}
                        r={size === "sm" ? 2.5 : 2.2}
                        fill={on ? tone : mix(tone, 18)}
                    />
                ))}
            </Glyph>
        </Tile>
    );
}

function NodeGraph({ model, size }: { model: SampleModel; size: Size }) {
    const next = stream(model.name, "graph");
    const tone = toneOf(model.name);
    const lattice: Point[] = [];
    for (const y of [4, 12, 20]) {
        for (const x of [4, 12, 20]) {
            lattice.push([x, y]);
        }
    }
    const order = lattice
        .map((point) => ({ point, key: next() }))
        .sort((a, b) => a.key - b.key)
        .map(({ point }) => point);
    const nodes = order.slice(0, pick(next, [4, 5]));
    const edges = nodes
        .slice(1)
        .map((node, index) => [pick(next, nodes.slice(0, index + 1)), node]);
    const stroke = STROKE[size] * 0.8;
    return (
        <Tile size={size} className="border bg-background">
            <Glyph size={size}>
                {edges.map(([from, to]) => (
                    <path
                        key={`${from}-${to}`}
                        d={`M${from[0]} ${from[1]}L${to[0]} ${to[1]}`}
                        stroke={mix(tone, 55)}
                        strokeWidth={stroke}
                    />
                ))}
                {nodes.map(([x, y], index) => (
                    <circle
                        key={`${x}-${y}`}
                        cx={x}
                        cy={y}
                        r={index === 0 ? 3.6 : 2.6}
                        fill={tone}
                    />
                ))}
            </Glyph>
        </Tile>
    );
}

function BoringBauhaus({ model, size }: { model: SampleModel; size: Size }) {
    const tone = toneOf(model.name);
    return (
        <Tile size={size}>
            <Avatar
                variant="bauhaus"
                square
                name={slugOf(model.name)}
                size={PIXELS[size]}
                colors={[mix(tone, 16), tone, toneOf(model.name, 4), "var(--card)"]}
            />
        </Tile>
    );
}

function BoringPixel({ model, size }: { model: SampleModel; size: Size }) {
    const tone = toneOf(model.name);
    return (
        <Tile size={size}>
            <Avatar
                variant="pixel"
                square
                name={slugOf(model.name)}
                size={PIXELS[size]}
                colors={[tone, mix(tone, 60), mix(tone, 30), mix(tone, 12)]}
            />
        </Tile>
    );
}

function dicebearShapesSvg(name: string): string {
    const tone = toneOf(name);
    const { hexes, paint } = placeholders([mix(tone, 14), tone, toneOf(name, 3), toneOf(name, 7)]);
    const [background, ...shapes] = hexes;
    shapesStyle ??= new Style(shapesDefinition);
    const svg = new DicebearAvatar(shapesStyle, {
        seed: slugOf(name),
        idRandomization: true,
        backgroundColor: [background],
        shape1Color: shapes,
        shape2Color: shapes,
        shape3Color: shapes,
    }).toString();
    return paint(cleanDicebear(svg));
}

function DicebearShapes({ model, size }: { model: SampleModel; size: Size }) {
    const markup = useMemo(() => dicebearShapesSvg(model.name), [model.name]);
    return (
        <Tile size={size}>
            <SvgMarkup markup={markup} />
        </Tile>
    );
}

function dicebearIdenticonSvg(name: string): string {
    const tone = toneOf(name);
    const { hexes, paint } = placeholders([tone]);
    identiconStyle ??= new Style(identiconDefinition);
    const svg = new DicebearAvatar(identiconStyle, {
        seed: slugOf(name),
        idRandomization: true,
        rowColor: hexes,
        scale: 0.7,
    }).toString();
    return paint(cleanDicebear(svg));
}

function DicebearIdenticon({ model, size }: { model: SampleModel; size: Size }) {
    const markup = useMemo(() => dicebearIdenticonSvg(model.name), [model.name]);
    return (
        <Tile size={size} style={{ backgroundColor: mix(toneOf(model.name), 14) }}>
            <SvgMarkup markup={markup} />
        </Tile>
    );
}

function Jdenticon({ model, size }: { model: SampleModel; size: Size }) {
    const markup = useMemo(
        () =>
            toSvg(cyrb53(slugOf(model.name)).toString(16).padStart(14, "0"), PIXELS[size], {
                padding: 0.1,
                backColor: "#00000000",
                lightness: { color: [0.42, 0.62], grayscale: [0.4, 0.6] },
                saturation: { color: 0.55, grayscale: 0 },
            }),
        [model.name, size],
    );
    return (
        <Tile size={size} className="border bg-background">
            <SvgMarkup markup={markup} />
        </Tile>
    );
}

function Minidenticon({ model, size }: { model: SampleModel; size: Size }) {
    const markup = useMemo(
        () =>
            minidenticon(slugOf(model.name), 0, 0, (seed) => cyrb53(seed) >>> 0).replace(
                /fill="[^"]*"/,
                'fill="currentColor"',
            ),
        [model.name],
    );
    return (
        <Tile size={size} style={softTile(model.name)}>
            <SvgMarkup markup={markup} />
        </Tile>
    );
}

export type Variant = {
    name: string;
    idea: string;
    source: string;
    licence: string;
    bends?: string;
    Icon: (props: { model: SampleModel; size: Size }) => ReactNode;
};

const CUSTOM = "Custom code";
const OURS = "This repo";

export const VARIANTS: Variant[] = [
    {
        name: "Mono monogram",
        idea: "Two initials in muted ink on the bordered tile base models use, so custom models sit quietly beside publisher logos.",
        source: CUSTOM,
        licence: OURS,
        bends: "One initial at 20 px; two do not fit at 13 px.",
        Icon: MonoMonogram,
    },
    {
        name: "Tinted monogram",
        idea: "Two initials in the model's tone on a 14% tint of it, with a tinted edge: one hue per name.",
        source: CUSTOM,
        licence: OURS,
        bends: "One initial at 20 px.",
        Icon: TintedMonogram,
    },
    {
        name: "Solid monogram",
        idea: "One initial in card ink on a solid tile of the model's tone; the loudest of the letter set.",
        source: CUSTOM,
        licence: OURS,
        Icon: SolidMonogram,
    },
    {
        name: "Task glyph",
        idea: "A lucide glyph chosen by the task (classify, extract, chat, review, SQL), tinted by name. Says what the model does.",
        source: "Custom code with lucide-react",
        licence: "ISC (lucide)",
        bends: "Two chat models differ only by tint.",
        Icon: TaskGlyph,
    },
    {
        name: "Base logo with notch",
        idea: "The base model's publisher logo, with a corner triangle in the model's tone marking it as custom.",
        source: "Custom code with the kit's ProviderLogo",
        licence: OURS,
        bends: "Brand colours of the publisher mark; models on one base look alike.",
        Icon: NotchedBase,
    },
    {
        name: "Base logo on tint",
        idea: "The publisher logo on a tint of the model's tone: provenance from the logo, identity from the colour.",
        source: "Custom code with the kit's ProviderLogo",
        licence: OURS,
        bends: "Brand colours of the publisher mark.",
        Icon: TintedBase,
    },
    {
        name: "Monogram with base badge",
        idea: "A tinted initial with the base publisher's logo in a small corner badge, like an organisation badge on an avatar.",
        source: "Custom code with the kit's ProviderLogo",
        licence: OURS,
        bends: "The badge overhangs the tile by 4 px; the logo is 8 px at 20 px.",
        Icon: BadgedMonogram,
    },
    {
        name: "Fork mark",
        idea: "A branch leaving a hollow base node and ending in a node of the model's tone: derived from a base, drawn as a fork.",
        source: CUSTOM,
        licence: OURS,
        Icon: ForkMark,
    },
    {
        name: "Arcs",
        idea: "Two arcs at hashed angles and lengths around a centre dot, in the model's tone on its tint.",
        source: CUSTOM,
        licence: OURS,
        Icon: Arcs,
    },
    {
        name: "Facets",
        idea: "Four squares split on hashed diagonals into eight triangles, each a step of the tone mixed into the card.",
        source: CUSTOM,
        licence: OURS,
        Icon: Facets,
    },
    {
        name: "Branch mark",
        idea: "The minibrain branches mark from /proto/logos, grown with a hashed depth, split and spread, in card ink on the tone.",
        source: CUSTOM,
        licence: OURS,
        Icon: BranchMark,
    },
    {
        name: "Letter in shape",
        idea: "The initial knocked out of a hashed shape (circle, hexagon, diamond, octagon, shield) in the model's tone.",
        source: CUSTOM,
        licence: OURS,
        bends: "The circle variant reads as a round avatar.",
        Icon: LetterInShape,
    },
    {
        name: "Dot matrix",
        idea: "A 4 by 4 mirrored grid of lit and unlit dots, like an LED panel, in the model's tone.",
        source: CUSTOM,
        licence: OURS,
        Icon: DotMatrix,
    },
    {
        name: "Node graph",
        idea: "Four or five nodes on a 3 by 3 lattice joined into a small tree: a network, read as a model.",
        source: CUSTOM,
        licence: OURS,
        Icon: NodeGraph,
    },
    {
        name: "Bauhaus (boring-avatars)",
        idea: "boring-avatars' bauhaus: a square, circle and bar at hashed positions, fed a tint, the tone, a second tone and card ink.",
        source: "boring-avatars 2.0.4",
        licence: "MIT",
        bends: "Two hues per tile; busier than the rest at 20 px.",
        Icon: BoringBauhaus,
    },
    {
        name: "Pixel mosaic (boring-avatars)",
        idea: "boring-avatars' pixel: an 8 by 8 mosaic, here in four steps of the model's tone only.",
        source: "boring-avatars 2.0.4",
        licence: "MIT",
        Icon: BoringPixel,
    },
    {
        name: "Shapes (DiceBear)",
        idea: "DiceBear's shapes style: three overlapping, rotated shapes on a tint, recoloured to three kit tones.",
        source: "@dicebear/core 10.7.0 and @dicebear/styles 10.6.0",
        licence: "MIT code, CC0 1.0 design",
        bends: "Shapes are cropped by the tile edge by design.",
        Icon: DicebearShapes,
    },
    {
        name: "Identicon (DiceBear)",
        idea: "DiceBear's identicon style: a mirrored 5 by 5 grid in the model's tone on its tint.",
        source: "@dicebear/core 10.7.0 and @dicebear/styles 10.6.0",
        licence: "MIT code, CC0 1.0 design",
        Icon: DicebearIdenticon,
    },
    {
        name: "Jdenticon",
        idea: "jdenticon's geometric identicon: rotated triangles and squares around a centre, the GitHub-era look.",
        source: "jdenticon 3.3.0",
        licence: "MIT",
        bends: "Its own HSL hex colours, not kit tokens; its default hash is SHA-1 (bypassed here by passing a hex hash).",
        Icon: Jdenticon,
    },
    {
        name: "Minidenticon",
        idea: "minidenticons: a mirrored 5 by 5 grid from a 0.5 KB function, drawn in currentColor on the model's tint.",
        source: "minidenticons 4.2.1",
        licence: "MIT",
        Icon: Minidenticon,
    },
];

export function CurrentLogo({ model, size }: { model: SampleModel; size: Size }) {
    return (
        <Tile size={size} className="border bg-background">
            <span className="text-sm font-semibold text-muted-foreground">
                {initials(model.name, 1)}
            </span>
        </Tile>
    );
}
