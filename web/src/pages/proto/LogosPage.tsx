import type { ComponentType, ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";

const BRAND = { fill: "#026ecd", glyph: "#ffffff" };

type Point = [number, number];
type GlyphProps = { color: string; ground: string; size: number; uid: string };

function weight(size: number, base: number): number {
    if (size >= 40) {
        return base;
    }
    if (size >= 22) {
        return base * 1.3;
    }
    return base * 1.7;
}

function fit(points: Point[], span: number): (point: Point) => Point {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const scale = span / Math.max(width, height);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    return ([x, y]) => [50 + (x - midX) * scale, 50 + (y - midY) * scale];
}

function at([x, y]: Point): string {
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
}

type TreeOptions = {
    depth: number;
    angle: number;
    ratio?: number;
    split?: 2 | 3;
    curved?: boolean;
    arms?: number[];
    roots?: number;
    span?: number;
};

type Tree = { d: string; tips: Point[] };

function tree({
    depth,
    angle,
    ratio = 0.7,
    split = 2,
    curved = false,
    arms = [0],
    roots = 0,
    span = 76,
}: TreeOptions): Tree {
    const segments: Point[][] = [];
    const ends: Point[] = [];
    const grow = (start: Point, heading: number, length: number, level: number, limit: number) => {
        const end: Point = [
            start[0] + length * Math.sin(heading),
            start[1] - length * Math.cos(heading),
        ];
        if (curved && level > 0) {
            const bend = heading > 0 ? 0.35 : heading < 0 ? -0.35 : 0;
            const control: Point = [
                start[0] + 0.55 * length * Math.sin(heading - bend),
                start[1] - 0.55 * length * Math.cos(heading - bend),
            ];
            segments.push([start, control, end]);
        } else {
            segments.push([start, end]);
        }
        if (level === limit) {
            ends.push(end);
            return;
        }
        const turns = split === 3 ? [-angle, 0, angle] : [-angle, angle];
        for (const turn of turns) {
            grow(end, heading + turn, length * ratio, level + 1, limit);
        }
    };
    for (const arm of arms) {
        grow([0, 0], arm, 1, 0, depth);
    }
    if (roots > 0) {
        grow([0, 0], Math.PI, 0.6, 0, roots);
    }
    const place = fit(segments.flat(), span);
    const d = segments
        .map((segment) => {
            const [first, ...rest] = segment.map(place);
            return rest.length === 2
                ? `M${at(first)} Q${at(rest[0])} ${at(rest[1])}`
                : `M${at(first)} L${at(rest[0])}`;
        })
        .join(" ");
    return { d, tips: ends.map(place) };
}

function treeGlyph(options: TreeOptions, stroke: number, tipDot = 0): ComponentType<GlyphProps> {
    const shape = tree(options);
    return function TreeGlyph({ color, size }: GlyphProps) {
        return (
            <g>
                <path
                    d={shape.d}
                    fill="none"
                    stroke={color}
                    strokeWidth={weight(size, stroke)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                {tipDot > 0 &&
                    shape.tips.map((tip) => (
                        <circle
                            key={at(tip)}
                            cx={tip[0]}
                            cy={tip[1]}
                            r={weight(size, tipDot)}
                            fill={color}
                        />
                    ))}
            </g>
        );
    };
}

function SeedlingGlyph({ color, size }: GlyphProps) {
    return (
        <g fill={color}>
            <path
                d="M50 86 V44"
                stroke={color}
                strokeWidth={weight(size, 8)}
                strokeLinecap="round"
                fill="none"
            />
            <path d="M50 58 C30 60 18 46 18 30 C36 30 50 40 50 58 Z" />
            <path d="M50 50 C70 52 82 38 82 22 C64 22 50 32 50 50 Z" />
        </g>
    );
}

type WaveOptions = {
    radius: number;
    rings: number[];
    stroke: number;
    clip: "circle" | "tile" | "band" | "horizon" | "square";
    alternate?: boolean;
    dot?: boolean;
};

function scaleCentres(radius: number): Point[] {
    const centres: Point[] = [];
    for (let row = 0; row * (radius / 2) <= 100 + radius; row += 1) {
        const shift = row % 2 === 0 ? 0 : radius;
        for (let x = -radius + shift; x <= 100 + radius; x += 2 * radius) {
            centres.push([x, row * (radius / 2)]);
        }
    }
    return centres;
}

function Scale({
    centre,
    options,
    color,
    ground,
    size,
}: {
    centre: Point;
    options: WaveOptions;
    color: string;
    ground: string;
    size: number;
}) {
    const stroke = weight(size, options.stroke);
    const [x, y] = centre;
    return (
        <g>
            <circle cx={x} cy={y} r={options.radius} fill={ground} />
            {options.rings.map((ring, order) =>
                options.alternate ? (
                    <circle
                        key={ring}
                        cx={x}
                        cy={y}
                        r={options.radius * ring}
                        fill={order % 2 === 0 ? color : ground}
                    />
                ) : (
                    <circle
                        key={ring}
                        cx={x}
                        cy={y}
                        r={options.radius * ring - stroke / 2}
                        fill="none"
                        stroke={color}
                        strokeWidth={stroke}
                    />
                ),
            )}
            {options.dot && <circle cx={x} cy={y} r={options.radius * 0.14} fill={color} />}
        </g>
    );
}

const WAVE_CLIPS: Record<WaveOptions["clip"], ReactNode> = {
    circle: <circle cx={50} cy={50} r={44} />,
    tile: <rect x={-10} y={-10} width={120} height={120} />,
    band: <rect x={6} y={28} width={88} height={44} rx={22} />,
    horizon: <rect x={0} y={56} width={100} height={44} />,
    square: <rect x={10} y={10} width={80} height={80} rx={18} />,
};

function wavesGlyph(options: WaveOptions): ComponentType<GlyphProps> {
    const centres = scaleCentres(options.radius);
    return function WavesGlyph({ color, ground, size, uid }: GlyphProps) {
        const id = `${uid}-clip`;
        const horizon = options.clip === "horizon";
        return (
            <g>
                <defs>
                    <clipPath id={id}>{WAVE_CLIPS[options.clip]}</clipPath>
                    <clipPath id={`${id}-disc`}>
                        <circle cx={50} cy={50} r={horizon ? 44 : 200} />
                    </clipPath>
                </defs>
                {horizon && <circle cx={50} cy={52} r={20} fill={color} />}
                <g clipPath={`url(#${id}-disc)`}>
                    <g clipPath={`url(#${id})`}>
                        {centres.map((centre) => (
                            <Scale
                                key={at(centre)}
                                centre={centre}
                                options={options}
                                color={color}
                                ground={ground}
                                size={size}
                            />
                        ))}
                    </g>
                </g>
            </g>
        );
    };
}

const PYRAMID: Point[] = [
    [50, 46],
    [28, 68],
    [72, 68],
];

function PyramidGlyph({ color, ground, size }: GlyphProps) {
    const options: WaveOptions = { radius: 22, rings: [1, 0.66, 0.33], stroke: 4.5, clip: "tile" };
    return (
        <g>
            {PYRAMID.map((centre) => (
                <Scale
                    key={at(centre)}
                    centre={centre}
                    options={options}
                    color={color}
                    ground={ground}
                    size={size}
                />
            ))}
            <rect x={0} y={68} width={100} height={32} fill={ground} />
        </g>
    );
}

type RainbowOptions = {
    radii: number[];
    stroke: number;
    kind?: "arc" | "arch" | "band" | "quarter" | "mirror" | "rings" | "offset";
    sun?: number;
    base?: number;
};

function rainbowGlyph({
    radii,
    stroke,
    kind = "arc",
    sun = 0,
    base = 68,
}: RainbowOptions): ComponentType<GlyphProps> {
    return function RainbowGlyph({ color, size }: GlyphProps) {
        const width = weight(size, stroke);
        const line = {
            fill: "none",
            stroke: color,
            strokeWidth: width,
            strokeLinecap: "round",
        } as const;
        if (kind === "band") {
            return (
                <g fill={color}>
                    {radii.map((outer) => {
                        const inner = outer - stroke;
                        return (
                            <path
                                key={outer}
                                d={`M${50 - outer} ${base} A${outer} ${outer} 0 0 1 ${50 + outer} ${base} H${50 + inner} A${inner} ${inner} 0 0 0 ${50 - inner} ${base} Z`}
                            />
                        );
                    })}
                </g>
            );
        }
        if (kind === "quarter") {
            return (
                <g {...line}>
                    {radii.map((radius) => (
                        <path
                            key={radius}
                            d={`M14 ${86 - radius} A${radius} ${radius} 0 0 1 ${14 + radius} 86`}
                        />
                    ))}
                </g>
            );
        }
        if (kind === "rings") {
            return (
                <g {...line}>
                    {radii.map((radius) => (
                        <circle key={radius} cx={50} cy={base} r={radius} />
                    ))}
                </g>
            );
        }
        if (kind === "mirror") {
            return (
                <g {...line}>
                    {radii.map((radius) => (
                        <g key={radius}>
                            <path
                                d={`M${50 - radius} 45 A${radius} ${radius} 0 0 1 ${50 + radius} 45`}
                            />
                            <path
                                d={`M${50 - radius} 57 A${radius} ${radius} 0 0 0 ${50 + radius} 57`}
                            />
                        </g>
                    ))}
                </g>
            );
        }
        return (
            <g>
                <g {...line}>
                    {radii.map((radius) => {
                        const order = radii.indexOf(radius);
                        const cx = kind === "offset" ? 44 + order * 6 : 50;
                        return kind === "arch" ? (
                            <path
                                key={radius}
                                d={`M${cx - radius} 86 V${base - radius / 2} A${radius} ${radius} 0 0 1 ${cx + radius} ${base - radius / 2} V86`}
                            />
                        ) : (
                            <path
                                key={radius}
                                d={`M${cx - radius} ${base} A${radius} ${radius} 0 0 1 ${cx + radius} ${base}`}
                            />
                        );
                    })}
                </g>
                {sun > 0 && <circle cx={50} cy={base} r={sun} fill={color} />}
            </g>
        );
    };
}

const DOME = "M24 68 C14 68 13 60 15 53 C19 33 33 22 50 22 C67 22 81 33 85 53 C87 60 86 68 76 68 Z";
const LEFT_HALF = "M46 18 C27 19 15 33 15 51 C15 69 27 83 46 84 Z";
const RIGHT_HALF = "M54 18 C73 19 85 33 85 51 C85 69 73 83 54 84 Z";

function stroked(size: number, base: number) {
    return {
        fill: "none",
        strokeWidth: weight(size, base),
        strokeLinecap: "round",
        strokeLinejoin: "round",
    } as const;
}

function DomeBrain({ color }: GlyphProps) {
    return (
        <g fill={color}>
            <path d={DOME} />
            <rect x={55} y={60} width={12} height={22} rx={6} />
        </g>
    );
}

function CloudBrain({ color }: GlyphProps) {
    return (
        <g fill={color}>
            <circle cx={33} cy={46} r={18} />
            <circle cx={52} cy={36} r={20} />
            <circle cx={70} cy={45} r={17} />
            <rect x={16} y={44} width={70} height={24} rx={12} />
            <rect x={56} y={60} width={12} height={22} rx={6} />
        </g>
    );
}

function HalvesBrain({ color }: GlyphProps) {
    return (
        <g fill={color}>
            <path d={LEFT_HALF} />
            <path d={RIGHT_HALF} />
        </g>
    );
}

function FoldedHalvesBrain({ color, ground, size }: GlyphProps) {
    return (
        <g>
            <path d={LEFT_HALF} fill={color} />
            <path d={RIGHT_HALF} fill={color} />
            <g stroke={ground} {...stroked(size, 5)}>
                <path d="M22 44 C28 38 34 50 41 42" />
                <path d="M22 62 C28 56 34 68 41 60" />
                <path d="M59 42 C66 50 72 38 78 44" />
                <path d="M59 60 C66 68 72 56 78 62" />
            </g>
        </g>
    );
}

function WalnutBrain({ color, size }: GlyphProps) {
    return (
        <g stroke={color} {...stroked(size, 8)}>
            <ellipse cx={50} cy={51} rx={33} ry={32} />
            <path d="M50 20 C42 31 58 41 50 51 C42 61 58 71 50 82" />
        </g>
    );
}

function FoldBrain({ color, size }: GlyphProps) {
    return (
        <g stroke={color} {...stroked(size, 7.5)}>
            <path d={DOME} />
            <path d="M28 56 C28 44 40 42 41 52 C42 40 58 40 59 52 C60 42 72 44 72 56" />
        </g>
    );
}

function StackedBrain({ color, size }: GlyphProps) {
    return (
        <g stroke={color} {...stroked(size, 8)}>
            <path d="M16 44 A8.5 8.5 0 0 1 33 44 A8.5 8.5 0 0 1 50 44 A8.5 8.5 0 0 1 67 44 A8.5 8.5 0 0 1 84 44" />
            <path d="M24 66 A8.5 8.5 0 0 1 41 66 A8.5 8.5 0 0 1 58 66 A8.5 8.5 0 0 1 75 66" />
        </g>
    );
}

const PIXELS = [".XXXX.", "XXXXXX", "XXXXXX", "XXXXX.", "...X.."];

const PIXEL_CELLS = PIXELS.flatMap((row, y) =>
    [...row].map((cell, x) => ({ id: `${x}:${y}`, on: cell === "X", x, y })),
).filter((cell) => cell.on);

function PixelBrain({ color }: GlyphProps) {
    const step = 13;
    const left = 50 - (6 * step) / 2;
    const top = 50 - (5 * step) / 2;
    return (
        <g fill={color}>
            {PIXEL_CELLS.map((cell) => (
                <rect
                    key={cell.id}
                    x={left + cell.x * step + 1}
                    y={top + cell.y * step + 1}
                    width={step - 2.5}
                    height={step - 2.5}
                    rx={3}
                />
            ))}
        </g>
    );
}

const NEURONS: { id: string; x: number; y: number; r: number }[] = [
    { id: "a", x: 30, y: 44, r: 12 },
    { id: "b", x: 52, y: 34, r: 13 },
    { id: "c", x: 73, y: 45, r: 12 },
    { id: "d", x: 39, y: 66, r: 11 },
    { id: "e", x: 62, y: 65, r: 11 },
    { id: "f", x: 70, y: 84, r: 6 },
];

function DotsBrain({ color }: GlyphProps) {
    return (
        <g fill={color}>
            {NEURONS.map((dot) => (
                <circle key={dot.id} cx={dot.x} cy={dot.y} r={dot.r} />
            ))}
        </g>
    );
}

function ProfileBrain({ color, size }: GlyphProps) {
    return (
        <g stroke={color} {...stroked(size, 7.5)}>
            <path d={DOME} />
            <path d="M50 24 C40 38 60 48 50 66" />
            <path d="M61 68 V80" />
        </g>
    );
}

type Variant = { id: string; name: string; Glyph: ComponentType<GlyphProps>; bleed?: boolean };
type Family = { id: string; name: string; idea: string; variants: Variant[] };

const THIRD = (2 * Math.PI) / 3;

const FAMILIES: Family[] = [
    {
        id: "brain",
        name: "Brain",
        idea: "The brain itself, kept to a few shapes so it reads from across a room.",
        variants: [
            { id: "x1", name: "Dome", Glyph: DomeBrain },
            { id: "x2", name: "Cloud", Glyph: CloudBrain },
            { id: "x3", name: "Halves", Glyph: HalvesBrain },
            { id: "x4", name: "Folded halves", Glyph: FoldedHalvesBrain },
            { id: "x5", name: "Walnut", Glyph: WalnutBrain },
            { id: "x6", name: "One fold", Glyph: FoldBrain },
            { id: "x7", name: "Gyri", Glyph: StackedBrain },
            { id: "x8", name: "Pixels", Glyph: PixelBrain },
            { id: "x9", name: "Neurons", Glyph: DotsBrain },
            { id: "x10", name: "Profile", Glyph: ProfileBrain },
        ],
    },
    {
        id: "branches",
        name: "Branches",
        idea: "One stem that keeps splitting: a base model that grows into as many models as you need.",
        variants: [
            { id: "b1", name: "Original", Glyph: treeGlyph({ depth: 4, angle: 0.5 }, 5.5) },
            {
                id: "b2",
                name: "Wide crown",
                Glyph: treeGlyph({ depth: 3, angle: 0.85, ratio: 0.66 }, 6.5),
            },
            {
                id: "b3",
                name: "Narrow",
                Glyph: treeGlyph({ depth: 4, angle: 0.32, ratio: 0.74 }, 5.5),
            },
            { id: "b4", name: "Budding", Glyph: treeGlyph({ depth: 3, angle: 0.55 }, 6, 4.5) },
            {
                id: "b5",
                name: "Bold",
                Glyph: treeGlyph({ depth: 2, angle: 0.6, ratio: 0.72 }, 11),
            },
            {
                id: "b6",
                name: "Trident",
                Glyph: treeGlyph({ depth: 2, angle: 0.62, split: 3, ratio: 0.62 }, 7.5),
            },
            {
                id: "b7",
                name: "Radial",
                Glyph: treeGlyph({ depth: 2, angle: 0.55, arms: [0, THIRD, 2 * THIRD] }, 6.5),
            },
            { id: "b8", name: "Roots", Glyph: treeGlyph({ depth: 2, angle: 0.6, roots: 2 }, 6.5) },
            {
                id: "b9",
                name: "Organic",
                Glyph: treeGlyph({ depth: 3, angle: 0.55, curved: true }, 6.5),
            },
            { id: "b10", name: "Seedling", Glyph: SeedlingGlyph },
        ],
    },
    {
        id: "waves",
        name: "Waves",
        idea: "Seigaiha, overlapping waves that stand for abundance and a calm that lasts.",
        variants: [
            {
                id: "w1",
                name: "Medallion",
                Glyph: wavesGlyph({
                    radius: 17,
                    rings: [1, 0.68, 0.36],
                    stroke: 3.6,
                    clip: "circle",
                }),
            },
            {
                id: "w2",
                name: "Large scales",
                Glyph: wavesGlyph({
                    radius: 25,
                    rings: [1, 0.66, 0.33],
                    stroke: 4.5,
                    clip: "circle",
                }),
            },
            {
                id: "w3",
                name: "Full bleed",
                Glyph: wavesGlyph({ radius: 24, rings: [1, 0.6], stroke: 3.5, clip: "tile" }),
                bleed: true,
            },
            {
                id: "w4",
                name: "Band",
                Glyph: wavesGlyph({ radius: 18, rings: [1, 0.6], stroke: 5, clip: "band" }),
            },
            { id: "w5", name: "Pyramid", Glyph: PyramidGlyph },
            {
                id: "w6",
                name: "Solid rings",
                Glyph: wavesGlyph({
                    radius: 24,
                    rings: [1, 0.72, 0.44],
                    stroke: 0,
                    clip: "circle",
                    alternate: true,
                }),
            },
            {
                id: "w7",
                name: "Two rings",
                Glyph: wavesGlyph({ radius: 24, rings: [1, 0.5], stroke: 7, clip: "circle" }),
            },
            {
                id: "w8",
                name: "Sunrise at sea",
                Glyph: wavesGlyph({ radius: 16, rings: [1, 0.6], stroke: 4.5, clip: "horizon" }),
            },
            {
                id: "w9",
                name: "Window",
                Glyph: wavesGlyph({
                    radius: 20,
                    rings: [1, 0.62, 0.3],
                    stroke: 4.5,
                    clip: "square",
                }),
            },
            {
                id: "w10",
                name: "Pearls",
                Glyph: wavesGlyph({
                    radius: 22,
                    rings: [1, 0.62],
                    stroke: 5,
                    clip: "circle",
                    dot: true,
                }),
            },
        ],
    },
    {
        id: "rainbow",
        name: "Rainbow",
        idea: "Arcs resting on one another: the oldest sign of a promise that lasts.",
        variants: [
            { id: "r1", name: "Original", Glyph: rainbowGlyph({ radii: [38, 24, 10], stroke: 9 }) },
            {
                id: "r2",
                name: "Four fine",
                Glyph: rainbowGlyph({ radii: [40, 30, 20, 10], stroke: 5.5 }),
            },
            { id: "r3", name: "Two heavy", Glyph: rainbowGlyph({ radii: [37, 17], stroke: 14 }) },
            {
                id: "r4",
                name: "Arches",
                Glyph: rainbowGlyph({ radii: [36, 22, 8], stroke: 8.5, kind: "arch", base: 58 }),
            },
            {
                id: "r5",
                name: "With sun",
                Glyph: rainbowGlyph({ radii: [38, 24], stroke: 9, sun: 8 }),
            },
            {
                id: "r6",
                name: "Reflection",
                Glyph: rainbowGlyph({ radii: [38, 24, 10], stroke: 7, kind: "mirror" }),
            },
            {
                id: "r7",
                name: "Solid bands",
                Glyph: rainbowGlyph({ radii: [42, 28, 14], stroke: 10, kind: "band" }),
            },
            {
                id: "r8",
                name: "Corner",
                Glyph: rainbowGlyph({ radii: [66, 48, 30], stroke: 10, kind: "quarter" }),
            },
            {
                id: "r9",
                name: "Drift",
                Glyph: rainbowGlyph({ radii: [38, 26, 14], stroke: 8.5, kind: "offset" }),
            },
            {
                id: "r10",
                name: "Sunrise",
                Glyph: rainbowGlyph({
                    radii: [62, 46, 30, 14],
                    stroke: 8,
                    kind: "rings",
                    base: 96,
                }),
                bleed: true,
            },
        ],
    },
];

type TileStyle = "brand" | "ink";

const TILE: Record<TileStyle, { fill: string; glyph: string }> = {
    brand: { fill: BRAND.fill, glyph: BRAND.glyph },
    ink: { fill: "var(--foreground)", glyph: "var(--background)" },
};

function Tile({
    variant,
    size,
    style = "brand",
}: {
    variant: Variant;
    size: number;
    style?: TileStyle;
}) {
    const { Glyph } = variant;
    const look = TILE[style];
    const inner = variant.bleed ? 1 : size >= 40 ? 0.7 : size >= 22 ? 0.78 : 0.88;
    const offset = 50 - 50 * inner;
    const uid = `${variant.id}-${style}-${size}`;
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <defs>
                <clipPath id={`${uid}-tile`}>
                    <rect x={0} y={0} width={100} height={100} rx={22} />
                </clipPath>
            </defs>
            <rect x={0} y={0} width={100} height={100} rx={22} fill={look.fill} />
            <g clipPath={`url(#${uid}-tile)`}>
                <g transform={`translate(${offset} ${offset}) scale(${inner})`}>
                    <Glyph color={look.glyph} ground={look.fill} size={size * inner} uid={uid} />
                </g>
            </g>
        </svg>
    );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-3 rounded-md border bg-background p-4">
            <span className="text-sm text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

function VariantCell({ family, variant }: { family: Family; variant: Variant }) {
    const number = family.variants.indexOf(variant) + 1;
    return (
        <Cell label={`${number}. ${variant.name}`}>
            <div className="flex items-end gap-3">
                <Tile variant={variant} size={64} />
                <Tile variant={variant} size={32} />
                <Tile variant={variant} size={16} />
                <Tile variant={variant} size={32} style="ink" />
            </div>
            <div className="flex items-center gap-2 text-foreground">
                <Tile variant={variant} size={22} />
                <span className="font-display text-lg font-semibold tracking-tight">minibrain</span>
            </div>
        </Cell>
    );
}

function FamilySection({ family }: { family: Family }) {
    return (
        <Section title={family.name} caption={family.idea}>
            <div className="flex flex-col gap-3">
                <Cell label="All ten at 16 pixels, the size of a browser tab">
                    <div className="flex flex-wrap items-center gap-3">
                        {family.variants.map((variant) => (
                            <Tile key={variant.id} variant={variant} size={16} />
                        ))}
                    </div>
                </Cell>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                    {family.variants.map((variant) => (
                        <VariantCell key={variant.id} family={family} variant={variant} />
                    ))}
                </div>
            </div>
        </Section>
    );
}

export function LogosPage() {
    return (
        <Page>
            <PageHeader
                title="Logos"
                caption="Ten simple brains, then ten versions each of Branches, Waves and Rainbow. Flat on Cobalt or ink. Prototype; not in the sidebar."
            />
            {FAMILIES.map((family) => (
                <FamilySection key={family.id} family={family} />
            ))}
        </Page>
    );
}
