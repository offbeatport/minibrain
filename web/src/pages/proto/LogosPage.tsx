import type { ComponentType, ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";

const BRAND = { fill: "#026ecd", glyph: "#ffffff" };

type GlyphProps = { color: string; size: number };

function weight(size: number, base: number): number {
    if (size >= 40) {
        return base;
    }
    if (size >= 22) {
        return base * 1.25;
    }
    return base * 1.6;
}

function AdapterGlyph({ color, size }: GlyphProps) {
    const gap = size >= 22 ? 8 : 11;
    const bar = size >= 22 ? 11 : 14;
    const side = 100 - 2 * 14 - gap - bar;
    const start = 14;
    const outer = start + side + gap;
    return (
        <g fill={color}>
            <rect x={start} y={start} width={side} height={side} rx={4} />
            <rect x={outer} y={start} width={bar} height={side} rx={3} />
            <rect x={start} y={outer} width={side} height={bar} rx={3} />
        </g>
    );
}

function NodeGlyph({ color, size }: GlyphProps) {
    const stroke = weight(size, 9);
    const dot = Math.max(stroke * 0.95, 8.5);
    return (
        <g>
            <path
                d="M22 72 V46 A14 14 0 0 1 50 46 V72 M50 46 A14 14 0 0 1 78 46 V72"
                fill="none"
                stroke={color}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            {[22, 50, 78].map((x) => (
                <circle key={x} cx={x} cy={74} r={dot} fill={color} />
            ))}
        </g>
    );
}

const LEFT_BRACE =
    "M40 16 C30 16 29 24 29 32 V40 C29 46 26 50 18 50 C26 50 29 54 29 60 V68 C29 76 30 84 40 84";
const RIGHT_BRACE =
    "M60 16 C70 16 71 24 71 32 V40 C71 46 74 50 82 50 C74 50 71 54 71 60 V68 C71 76 70 84 60 84";

function BracesGlyph({ color, size }: GlyphProps) {
    const stroke = weight(size, 8);
    return (
        <g>
            <path
                d={`${LEFT_BRACE} ${RIGHT_BRACE}`}
                fill="none"
                stroke={color}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx={50} cy={50} r={size >= 22 ? 8 : 10} fill={color} />
        </g>
    );
}

function StrataGlyph({ color, size }: GlyphProps) {
    const height = size >= 22 ? 15 : 18;
    const gap = size >= 22 ? 6 : 7;
    const top = 50 - (3 * height + 2 * gap) / 2;
    const bars: [number, number][] = [
        [30, 76],
        [16, 84],
        [24, 64],
    ];
    return (
        <g fill={color}>
            {bars.map(([from, to], index) => (
                <rect
                    key={from}
                    x={from}
                    y={top + index * (height + gap)}
                    width={to - from}
                    height={height}
                    rx={height / 2}
                />
            ))}
        </g>
    );
}

function SplitGlyph({ color, size }: GlyphProps) {
    const gap = size >= 22 ? 7 : 10;
    const cut = 63;
    const id = `split-${size}-${color.replace(/[^a-z0-9]/gi, "")}`;
    return (
        <g>
            <defs>
                <clipPath id={`${id}-a`}>
                    <rect x={0} y={0} width={cut - gap / 2} height={100} />
                </clipPath>
                <clipPath id={`${id}-b`}>
                    <rect x={cut + gap / 2} y={0} width={100} height={100} />
                </clipPath>
            </defs>
            <circle cx={50} cy={50} r={34} fill={color} clipPath={`url(#${id}-a)`} />
            <circle cx={50} cy={50} r={34} fill={color} clipPath={`url(#${id}-b)`} />
        </g>
    );
}

type Concept = { id: string; name: string; idea: string; Glyph: ComponentType<GlyphProps> };

const CONCEPTS: Concept[] = [
    {
        id: "adapter",
        name: "Adapter",
        idea: "A solid square, the base model, with two thin strips on its sides: the adapter you train on top of any base.",
        Glyph: AdapterGlyph,
    },
    {
        id: "node",
        name: "Node m",
        idea: "A lowercase m whose feet are three nodes joined by two arches: a network and the letter at once.",
        Glyph: NodeGlyph,
    },
    {
        id: "braces",
        name: "Braces",
        idea: "Two braces as the halves of a brain around a point: your data in, your format out.",
        Glyph: BracesGlyph,
    },
    {
        id: "strata",
        name: "Strata",
        idea: "Three offset bars that stack into a brain's outline: data, model and serving.",
        Glyph: StrataGlyph,
    },
    {
        id: "split",
        name: "Split cell",
        idea: "One circle cut once into a large part and a small one: the general model and what you make of it.",
        Glyph: SplitGlyph,
    },
];

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
    const inner = size >= 40 ? 0.66 : size >= 22 ? 0.74 : 0.84;
    const offset = 50 - 50 * inner;
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <rect
                x={0.5}
                y={0.5}
                width={99}
                height={99}
                rx={22}
                fill={look.fill}
                stroke={look.border ?? "none"}
            />
            <g transform={`translate(${offset} ${offset}) scale(${inner})`}>
                <Glyph color={look.glyph} size={size * inner} />
            </g>
        </svg>
    );
}

function Bare({ concept, size, color }: { concept: Concept; size: number; color: string }) {
    const { Glyph } = concept;
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <Glyph color={color} size={size} />
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
                        <Bare concept={concept} size={40} color="var(--background)" />
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
                <Cell label="Sidebar header">
                    <div className="flex w-full flex-col gap-2">
                        {CONCEPTS.map((concept) => (
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
                                {CONCEPTS.map((concept) => (
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
                caption="Five original directions, flat on Cobalt or ink. Prototype; not in the sidebar."
            />
            <CompareSection />
            {CONCEPTS.map((concept, index) => (
                <ConceptSection key={concept.id} concept={concept} index={index} />
            ))}
        </Page>
    );
}
