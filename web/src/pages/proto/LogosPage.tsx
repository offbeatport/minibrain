import type { ComponentType, ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";

const BRAND = { fill: "#026ecd", glyph: "#ffffff" };
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PHI_GROWTH = Math.log((1 + Math.sqrt(5)) / 2) / (Math.PI / 2);

type GlyphProps = { color: string; ground: string; size: number };

function weight(size: number, base: number): number {
    if (size >= 40) {
        return base;
    }
    if (size >= 22) {
        return base * 1.3;
    }
    return base * 1.7;
}

function centred(points: [number, number][], span: number): [number, number][] {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const scale = span / Math.max(width, height);
    const left = (Math.min(...xs) + Math.max(...xs)) / 2;
    const top = (Math.min(...ys) + Math.max(...ys)) / 2;
    return points.map(([x, y]) => [50 + (x - left) * scale, 50 + (y - top) * scale]);
}

function line(points: [number, number][]): string {
    return `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L")}`;
}

function RegressGlyph({ color, size }: GlyphProps) {
    const ratio = 0.7;
    const vanish: [number, number] = [66, 34];
    const count = size >= 40 ? 5 : size >= 22 ? 4 : 3;
    const stroke = weight(size, 5);
    return (
        <g fill="none" stroke={color} strokeWidth={stroke}>
            {Array.from({ length: count }, (_, index) => {
                const shrink = ratio ** index;
                const side = 74 * shrink;
                const cx = vanish[0] + (50 - vanish[0]) * shrink;
                const cy = vanish[1] + (50 - vanish[1]) * shrink;
                return (
                    <rect
                        key={side}
                        x={cx - side / 2}
                        y={cy - side / 2}
                        width={side}
                        height={side}
                        rx={side * 0.22}
                    />
                );
            })}
        </g>
    );
}

function seeds(count: number): { id: string; x: number; y: number; r: number }[] {
    const spacing = 41 / Math.sqrt(count);
    return Array.from({ length: count }, (_, index) => {
        const radius = spacing * Math.sqrt(index + 0.5);
        const angle = index * GOLDEN_ANGLE;
        return {
            id: `seed-${count}-${index}`,
            x: 50 + radius * Math.cos(angle),
            y: 50 + radius * Math.sin(angle),
            r: spacing * (0.32 + 0.22 * Math.sqrt(index / count)),
        };
    });
}

const SEEDS = { large: seeds(55), medium: seeds(34), small: seeds(21) };

function SeedsGlyph({ color, size }: GlyphProps) {
    const dots = size >= 40 ? SEEDS.large : size >= 22 ? SEEDS.medium : SEEDS.small;
    return (
        <g fill={color}>
            {dots.map((dot) => (
                <circle key={dot.id} cx={dot.x} cy={dot.y} r={dot.r} />
            ))}
        </g>
    );
}

const SPIRAL = (() => {
    const points: [number, number][] = [];
    const turns = 3.6 * Math.PI;
    for (let index = 0; index <= 360; index += 1) {
        const theta = (turns * index) / 360;
        const radius = Math.exp(PHI_GROWTH * theta);
        points.push([radius * Math.cos(theta), -radius * Math.sin(theta)]);
    }
    return line(centred(points, 74));
})();

function SpiralGlyph({ color, size }: GlyphProps) {
    return (
        <path
            d={SPIRAL}
            fill="none"
            stroke={color}
            strokeWidth={weight(size, 6.5)}
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    );
}

function branches(depth: number): string {
    const segments: [number, number][][] = [];
    const grow = (x: number, y: number, angle: number, length: number, level: number) => {
        const end: [number, number] = [x + length * Math.sin(angle), y - length * Math.cos(angle)];
        segments.push([[x, y], end]);
        if (level === depth) {
            return;
        }
        grow(end[0], end[1], angle - 0.5, length * 0.7, level + 1);
        grow(end[0], end[1], angle + 0.5, length * 0.7, level + 1);
    };
    grow(0, 0, 0, 1, 0);
    const all = centred(segments.flat(), 76);
    const paths: string[] = [];
    for (let index = 0; index < all.length; index += 2) {
        paths.push(line([all[index], all[index + 1]]));
    }
    return paths.join(" ");
}

const TREE: Record<number, string> = { 3: branches(3), 4: branches(4) };

function BranchesGlyph({ color, size }: GlyphProps) {
    return (
        <path
            d={TREE[size >= 40 ? 4 : 3]}
            fill="none"
            stroke={color}
            strokeWidth={weight(size, 5.5)}
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    );
}

function WavesGlyph({ color, ground, size }: GlyphProps) {
    const radius = size >= 40 ? 17 : size >= 22 ? 21 : 26;
    const rings = size >= 40 ? [1, 0.68, 0.36] : [1, 0.5];
    const stroke = weight(size, 3.6);
    const id = `waves-${size}-${color.replace(/[^a-z0-9]/gi, "")}`;
    const scales: [number, number][] = [];
    for (let row = 0; row * (radius / 2) <= 100 + radius; row += 1) {
        const y = row * (radius / 2);
        const shift = row % 2 === 0 ? 0 : radius;
        for (let x = -radius + shift; x <= 100 + radius; x += 2 * radius) {
            scales.push([x, y]);
        }
    }
    return (
        <g>
            <defs>
                <clipPath id={id}>
                    <circle cx={50} cy={50} r={44} />
                </clipPath>
            </defs>
            <g clipPath={`url(#${id})`}>
                {scales.map(([x, y]) => (
                    <g key={`${x}-${y}`}>
                        <circle cx={x} cy={y} r={radius} fill={ground} />
                        {rings.map((ring) => (
                            <circle
                                key={ring}
                                cx={x}
                                cy={y}
                                r={radius * ring - stroke / 2}
                                fill="none"
                                stroke={color}
                                strokeWidth={stroke}
                            />
                        ))}
                    </g>
                ))}
            </g>
        </g>
    );
}

function DoorsGlyph({ color, size }: GlyphProps) {
    const sides = size >= 22 ? [76, 48, 22] : [76, 40];
    const vanish: [number, number] = [62, 38];
    return (
        <g fill="none" stroke={color} strokeWidth={weight(size, 9)}>
            {sides.map((side) => {
                const shrink = side / 76;
                const cx = vanish[0] + (50 - vanish[0]) * shrink;
                const cy = vanish[1] + (50 - vanish[1]) * shrink;
                return (
                    <rect
                        key={side}
                        x={cx - side / 2}
                        y={cy - side / 2}
                        width={side}
                        height={side}
                        rx={side * 0.24}
                    />
                );
            })}
        </g>
    );
}

function OverflowGlyph({ color, size }: GlyphProps) {
    const stroke = weight(size, 11);
    return (
        <g>
            <path
                d="M16 50 A34 34 0 0 0 84 50"
                fill="none"
                stroke={color}
                strokeWidth={stroke}
                strokeLinecap="round"
            />
            <circle cx={50} cy={40} r={size >= 22 ? 21 : 23} fill={color} />
        </g>
    );
}

function RainbowGlyph({ color, size }: GlyphProps) {
    const radii = size >= 22 ? [38, 24, 10] : [36, 16];
    const stroke = size >= 22 ? weight(size, 9) : 14;
    return (
        <g fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round">
            {radii.map((radius) => (
                <path
                    key={radius}
                    d={`M${50 - radius} 70 A${radius} ${radius} 0 0 1 ${50 + radius} 70`}
                />
            ))}
        </g>
    );
}

function FieldGlyph({ color, size }: GlyphProps) {
    const step = size >= 22 ? 40 : 43;
    const radius = size >= 22 ? 10.5 : 13;
    const spots = [-1, 0, 1].flatMap((row) =>
        [-1, 0, 1].map((column) => ({
            id: `${row}:${column}`,
            x: 50 + column * step,
            y: 50 + row * step,
        })),
    );
    return (
        <g fill={color}>
            {spots.map((spot) => (
                <circle key={spot.id} cx={spot.x} cy={spot.y} r={radius} />
            ))}
        </g>
    );
}

const COIL = (() => {
    const points: [number, number][] = [];
    const turns = 3.2 * Math.PI;
    for (let index = 0; index <= 240; index += 1) {
        const theta = (turns * index) / 240;
        const radius = 1 + theta;
        points.push([radius * Math.cos(theta), radius * Math.sin(theta)]);
    }
    return line(centred(points, 70));
})();

function CoilGlyph({ color, size }: GlyphProps) {
    return (
        <path
            d={COIL}
            fill="none"
            stroke={color}
            strokeWidth={weight(size, 10)}
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    );
}

type Concept = {
    id: string;
    name: string;
    idea: string;
    Glyph: ComponentType<GlyphProps>;
    bleed?: boolean;
};

const CONCEPTS: Concept[] = [
    {
        id: "regress",
        name: "Regress",
        idea: "Squares inside squares, falling towards one point and never reaching it: there is always another model inside.",
        Glyph: RegressGlyph,
    },
    {
        id: "seeds",
        name: "Seeds",
        idea: "Dots set at the golden angle, the way sunflower seeds pack: growth that keeps going and fills every gap.",
        Glyph: SeedsGlyph,
    },
    {
        id: "spiral",
        name: "Spiral",
        idea: "A golden spiral: the same shape at every scale, widening for ever.",
        Glyph: SpiralGlyph,
    },
    {
        id: "branches",
        name: "Branches",
        idea: "One stem that keeps splitting in two: a base model that grows into as many models as you need.",
        Glyph: BranchesGlyph,
    },
    {
        id: "waves",
        name: "Waves",
        idea: "Seigaiha, the Japanese pattern of overlapping waves that stands for abundance and calm that lasts. It runs past the edge.",
        Glyph: WavesGlyph,
    },
];

const BOLD: Concept[] = [
    {
        id: "doors",
        name: "Doors",
        idea: "Three heavy frames, one inside the next, heading for a point you never reach. Regress, readable across a room.",
        Glyph: DoorsGlyph,
    },
    {
        id: "overflow",
        name: "Overflow",
        idea: "A bowl holding more than it can: the full moon sits higher than its rim.",
        Glyph: OverflowGlyph,
    },
    {
        id: "rainbow",
        name: "Rainbow",
        idea: "Three arcs, the oldest sign of a promise that lasts. Each band rests on the one below.",
        Glyph: RainbowGlyph,
    },
    {
        id: "field",
        name: "Field",
        idea: "A grid of dots cut off by the edge of the tile, so it reads as one corner of something that never ends.",
        Glyph: FieldGlyph,
        bleed: true,
    },
    {
        id: "coil",
        name: "Coil",
        idea: "A thick spiral, two turns and opening: the spiral idea at a weight that survives 16 pixels.",
        Glyph: CoilGlyph,
    },
];

const ALL = [...CONCEPTS, ...BOLD];

type TileStyle = "brand" | "ink" | "paper";

const TILE: Record<TileStyle, { fill: string; glyph: string; border?: string }> = {
    brand: { fill: BRAND.fill, glyph: BRAND.glyph },
    ink: { fill: "var(--foreground)", glyph: "var(--background)" },
    paper: { fill: "var(--card)", glyph: BRAND.fill, border: "var(--border)" },
};

function Tile({
    concept,
    size,
    style = "brand",
}: { concept: Concept; size: number; style?: TileStyle }) {
    const { Glyph } = concept;
    const look = TILE[style];
    const inner = concept.bleed ? 1 : size >= 40 ? 0.7 : size >= 22 ? 0.78 : 0.88;
    const offset = 50 - 50 * inner;
    const clip = `tile-${concept.id}-${style}-${size}`;
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <defs>
                <clipPath id={clip}>
                    <rect x={0} y={0} width={100} height={100} rx={22} />
                </clipPath>
            </defs>
            <rect
                x={0.5}
                y={0.5}
                width={99}
                height={99}
                rx={22}
                fill={look.fill}
                stroke={look.border ?? "none"}
            />
            <g clipPath={`url(#${clip})`}>
                <g transform={`translate(${offset} ${offset}) scale(${inner})`}>
                    <Glyph color={look.glyph} ground={look.fill} size={size * inner} />
                </g>
            </g>
        </svg>
    );
}

function Bare({
    concept,
    size,
    color,
    ground,
}: {
    concept: Concept;
    size: number;
    color: string;
    ground: string;
}) {
    const { Glyph } = concept;
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <Glyph color={color} ground={ground} size={size} />
        </svg>
    );
}

function Wordmark({ className }: { className: string }) {
    return (
        <span className={`font-display font-semibold tracking-tight ${className}`}>minibrain</span>
    );
}

function Cell({
    label,
    children,
    className = "bg-background",
    labelClassName = "text-muted-foreground",
}: {
    label: string;
    children: ReactNode;
    className?: string;
    labelClassName?: string;
}) {
    return (
        <div className={`flex min-w-0 flex-col gap-3 rounded-md border p-4 ${className}`}>
            <span className={`text-sm ${labelClassName}`}>{label}</span>
            <div className="flex flex-1 flex-wrap items-center gap-4">{children}</div>
        </div>
    );
}

function Sizes({ concept, style }: { concept: Concept; style: TileStyle }) {
    return (
        <div className="flex items-end gap-3">
            <Tile concept={concept} size={64} style={style} />
            <Tile concept={concept} size={32} style={style} />
            <Tile concept={concept} size={16} style={style} />
        </div>
    );
}

function ConceptSection({ concept, index }: { concept: Concept; index: number }) {
    return (
        <Section title={`${index + 1}. ${concept.name}`} caption={concept.idea}>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Cell label="Cobalt">
                    <Sizes concept={concept} style="brand" />
                </Cell>
                <Cell label="Ink">
                    <Sizes concept={concept} style="ink" />
                </Cell>
                <Cell label="Lockup">
                    <div className="flex items-center gap-3 text-foreground">
                        <Tile concept={concept} size={44} />
                        <Wordmark className="text-3xl" />
                    </div>
                </Cell>
                <Cell
                    label="Mark only, inverse"
                    className="bg-foreground"
                    labelClassName="text-background"
                >
                    <div className="flex items-center gap-3 text-background">
                        <Bare
                            concept={concept}
                            size={40}
                            color="var(--background)"
                            ground="var(--foreground)"
                        />
                        <Wordmark className="text-2xl" />
                    </div>
                </Cell>
            </div>
        </Section>
    );
}

function CompareSection() {
    return (
        <Section
            title="Side by side"
            caption="Where a mark has to work hardest: the sidebar and the browser tab."
        >
            <div className="grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2">
                    <Cell label="All ten at 48 and 24 pixels: detailed on the left, bold on the right">
                        <div className="flex flex-col gap-3">
                            {[48, 24].map((size) => (
                                <div key={size} className="flex flex-wrap items-center gap-3">
                                    {ALL.map((concept) => (
                                        <Tile key={concept.id} concept={concept} size={size} />
                                    ))}
                                </div>
                            ))}
                        </div>
                    </Cell>
                </div>
                <Cell label="Sidebar header">
                    <div className="flex w-full flex-col gap-2">
                        {ALL.map((concept) => (
                            <div
                                key={concept.id}
                                className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
                            >
                                <Tile concept={concept} size={22} />
                                <span className="text-base font-semibold">minibrain</span>
                                <span className="ml-auto text-sm text-muted-foreground">
                                    {concept.name}
                                </span>
                            </div>
                        ))}
                    </div>
                </Cell>
                <Cell label="Browser tabs at 16px">
                    <div className="flex w-full flex-col gap-2">
                        {(["brand", "ink", "paper"] as const).map((style) => (
                            <div key={style} className="flex flex-wrap gap-1">
                                {ALL.map((concept) => (
                                    <div
                                        key={concept.id}
                                        className="flex items-center gap-1.5 rounded-t-md border border-b-0 bg-card px-2.5 py-1.5"
                                    >
                                        <Tile concept={concept} size={16} style={style} />
                                        <span className="text-sm">Models</span>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                </Cell>
            </div>
        </Section>
    );
}

export function LogosPage() {
    return (
        <Page>
            <PageHeader
                title="Logos"
                caption="Ten original directions on infinity, abundance and forever: five detailed, five bold enough to read across a room. Flat on Cobalt or ink. Prototype; not in the sidebar."
            />
            <CompareSection />
            {ALL.map((concept, index) => (
                <ConceptSection key={concept.id} concept={concept} index={index} />
            ))}
        </Page>
    );
}
