import { type ComponentType, type ReactNode, createContext, useContext, useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";

const ORIGINAL = "/proto/knot-icon.png";

type Palette = { id: string; name: string; from: string; to: string; flat: string; glyph: string };

const PALETTES: Palette[] = [
    {
        id: "ember",
        name: "Ember",
        from: "#ff3b22",
        to: "#ffa23f",
        flat: "#ff5a2a",
        glyph: "#ffeadf",
    },
    {
        id: "amber",
        name: "Amber",
        from: "#c2410c",
        to: "#fbbf24",
        flat: "#ea7a0c",
        glyph: "#fff6e5",
    },
    {
        id: "magenta",
        name: "Magenta",
        from: "#b0127a",
        to: "#ff6f91",
        flat: "#db2777",
        glyph: "#ffeaf2",
    },
    {
        id: "violet",
        name: "Violet",
        from: "#4c1dd8",
        to: "#a46bff",
        flat: "#6a3df0",
        glyph: "#f1ebff",
    },
    {
        id: "cobalt",
        name: "Cobalt",
        from: "#024fb0",
        to: "#3b8cff",
        flat: "#026ecd",
        glyph: "#eaf3ff",
    },
    { id: "teal", name: "Teal", from: "#06615d", to: "#22c3ae", flat: "#0f8f84", glyph: "#e3fbf7" },
    {
        id: "forest",
        name: "Forest",
        from: "#0f5132",
        to: "#3fbf6f",
        flat: "#16803c",
        glyph: "#e8f8ee",
    },
    {
        id: "graphite",
        name: "Graphite",
        from: "#16171a",
        to: "#4b4e57",
        flat: "#2b2d33",
        glyph: "#f1f2f4",
    },
];

const PaletteContext = createContext<Palette>(PALETTES[0]);

type Point = [number, number];

function curve(
    at: (t: number) => Point,
    from: number,
    to: number,
    closed: boolean,
    box = 64,
): string {
    const steps = 480;
    const points: Point[] = [];
    for (let index = 0; index <= steps; index += 1) {
        points.push(at(from + ((to - from) * index) / steps));
    }
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const scale =
        box / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const text = points.map(
        ([x, y]) => `${(50 + (x - cx) * scale).toFixed(2)} ${(50 + (y - cy) * scale).toFixed(2)}`,
    );
    return `M${text.join(" L")}${closed ? " Z" : ""}`;
}

const TAU = 2 * Math.PI;

const PATHS = {
    trefoil: curve(
        (t) => [Math.sin(t) + 2 * Math.sin(2 * t), 2 * Math.cos(2 * t) - Math.cos(t)],
        0,
        TAU,
        true,
    ),
    pulse: curve((t) => [Math.sin(2 * t), Math.sin(3 * t)], 0, TAU, true),
    seed: curve(
        (t) => [(0.38 + Math.cos(t)) * Math.sin(t), (0.38 + Math.cos(t)) * Math.cos(t)],
        0,
        TAU,
        true,
    ),
    loop: curve((t) => [t - 2.2 * Math.sin(t), 3 * Math.cos(t)], 0, 2 * TAU, false, 66),
};

function strokeFor(size: number): number {
    if (size >= 40) {
        return 5;
    }
    if (size >= 22) {
        return 7;
    }
    return 9;
}

type GlyphProps = { size: number; color: string; uid: string };

function PathGlyph({ d }: { d: string }) {
    return function Glyph({ size, color }: GlyphProps) {
        return (
            <path
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={strokeFor(size)}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        );
    };
}

function LinkGlyph({ size, color, uid }: GlyphProps) {
    const width = strokeFor(size) + 1;
    const gap = width + 7;
    return (
        <>
            <defs>
                <mask
                    id={`${uid}-big`}
                    maskUnits="userSpaceOnUse"
                    x="0"
                    y="0"
                    width="100"
                    height="100"
                >
                    <rect width="100" height="100" fill="white" />
                    <path
                        d="M50.61 41.01 A13 13 0 0 1 58.58 37.08"
                        stroke="black"
                        strokeWidth={gap}
                        fill="none"
                    />
                </mask>
                <mask
                    id={`${uid}-small`}
                    maskUnits="userSpaceOnUse"
                    x="0"
                    y="0"
                    width="100"
                    height="100"
                >
                    <rect width="100" height="100" fill="white" />
                    <path
                        d="M56.71 57.06 A20 20 0 0 1 50.69 65.46"
                        stroke="black"
                        strokeWidth={gap}
                        fill="none"
                    />
                </mask>
            </defs>
            <g transform="translate(4.5 0)">
                <circle
                    cx="38"
                    cy="50"
                    r="20"
                    fill="none"
                    stroke={color}
                    strokeWidth={width}
                    mask={`url(#${uid}-big)`}
                />
                <circle
                    cx="60"
                    cy="50"
                    r="13"
                    fill="none"
                    stroke={color}
                    strokeWidth={width}
                    mask={`url(#${uid}-small)`}
                />
            </g>
        </>
    );
}

type Concept = { id: string; name: string; idea: string; Glyph: ComponentType<GlyphProps> };

const CONCEPTS: Concept[] = [
    {
        id: "trefoil",
        name: "Trefoil",
        idea: "The simplest true knot: three lobes, one unbroken line. A small model, tied tight.",
        Glyph: PathGlyph({ d: PATHS.trefoil }),
    },
    {
        id: "pulse",
        name: "Pulse",
        idea: "A 3:2 Lissajous figure, the trace two brain waves draw together.",
        Glyph: PathGlyph({ d: PATHS.pulse }),
    },
    {
        id: "seed",
        name: "Seed",
        idea: "One line that draws a large loop with a small one inside it: the minibrain within the brain.",
        Glyph: PathGlyph({ d: PATHS.seed }),
    },
    {
        id: "link",
        name: "Link",
        idea: "A large ring and a small ring, interlocked: the teacher model and the student it trains.",
        Glyph: LinkGlyph,
    },
    {
        id: "loop",
        name: "Loop m",
        idea: "A single stroke that writes an m and loops once between the arches.",
        Glyph: PathGlyph({ d: PATHS.loop }),
    },
];

type TileStyle = "gradient" | "flat" | "ink" | "paper";

function Mark({ concept, size }: { concept: Concept; size: number }) {
    const brand = useContext(PaletteContext);
    const { Glyph } = concept;
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <Glyph size={size} color={brand.flat} uid={`mark-${concept.id}-${brand.id}-${size}`} />
        </svg>
    );
}

function Tile({
    concept,
    size,
    style = "gradient",
}: { concept: Concept; size: number; style?: TileStyle }) {
    const brand = useContext(PaletteContext);
    const uid = `tile-${concept.id}-${brand.id}-${style}-${size}`;
    const fills: Record<TileStyle, string> = {
        gradient: `url(#${uid}-fill)`,
        flat: brand.flat,
        ink: "var(--foreground)",
        paper: "var(--card)",
    };
    const glyph: Record<TileStyle, string> = {
        gradient: brand.glyph,
        flat: brand.glyph,
        ink: "var(--background)",
        paper: brand.flat,
    };
    const { Glyph } = concept;
    const inner = size >= 48 ? 0.78 : 0.9;
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <defs>
                <linearGradient id={`${uid}-fill`} x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" stopColor={brand.from} />
                    <stop offset="1" stopColor={brand.to} />
                </linearGradient>
            </defs>
            <rect
                width="100"
                height="100"
                rx="23"
                fill={fills[style]}
                stroke={style === "paper" ? "var(--border)" : "none"}
            />
            <g transform={`translate(${50 - 50 * inner} ${50 - 50 * inner}) scale(${inner})`}>
                <Glyph size={size * inner} color={glyph[style]} uid={uid} />
            </g>
        </svg>
    );
}

function Wordmark({ className }: { className: string }) {
    return (
        <span className={`font-display font-semibold tracking-tight ${className}`}>minibrain</span>
    );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-3 rounded-md border bg-background p-4">
            <span className="text-sm text-muted-foreground">{label}</span>
            <div className="flex flex-1 flex-wrap items-center gap-4">{children}</div>
        </div>
    );
}

function ConceptRow({ concept, index }: { concept: Concept; index: number }) {
    return (
        <Section title={`${index + 1} · ${concept.name}`} caption={concept.idea}>
            <div className="grid gap-3 lg:grid-cols-[2fr_1fr_1.4fr]">
                <Cell label="Large">
                    <div className="flex items-center gap-3 text-foreground">
                        <Tile concept={concept} size={56} />
                        <Wordmark className="text-4xl" />
                    </div>
                    <div className="flex items-center gap-3 text-foreground">
                        <Mark concept={concept} size={48} />
                        <Wordmark className="text-3xl" />
                    </div>
                </Cell>
                <Cell label="Small">
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <Tile concept={concept} size={22} />
                            <span className="text-base font-semibold">minibrain</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Mark concept={concept} size={20} />
                            <span className="text-base font-semibold">minibrain</span>
                        </div>
                    </div>
                </Cell>
                <Cell label="Favicon">
                    <div className="flex flex-col gap-3">
                        <div className="flex items-end gap-3">
                            <Tile concept={concept} size={48} />
                            <Tile concept={concept} size={32} />
                            <Tile concept={concept} size={16} />
                            <Tile concept={concept} size={32} style="ink" />
                            <Tile concept={concept} size={32} style="paper" />
                        </div>
                        <div className="flex w-fit items-center gap-2 rounded-t-md border border-b-0 bg-card px-3 py-1.5">
                            <Tile concept={concept} size={16} />
                            <span className="text-sm">minibrain · Models</span>
                        </div>
                    </div>
                </Cell>
            </div>
        </Section>
    );
}

function Swatch({ label, color }: { label: string; color: string }) {
    return (
        <div className="flex items-center gap-2">
            <span className="size-6 rounded-md border" style={{ background: color }} />
            <span className="flex flex-col">
                <span className="text-sm text-muted-foreground">{label}</span>
                <span className="font-mono text-sm">{color}</span>
            </span>
        </div>
    );
}

function PaletteSection({
    selected,
    onSelect,
}: { selected: Palette; onSelect: (palette: Palette) => void }) {
    return (
        <Section title="Palette" caption="Click a palette to recolour every mark below.">
            <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                    {PALETTES.map((palette) => (
                        <button
                            key={palette.id}
                            type="button"
                            onClick={() => onSelect(palette)}
                            aria-pressed={palette.id === selected.id}
                            className={`flex flex-col items-center gap-1.5 rounded-md border px-3 py-2 text-sm ${
                                palette.id === selected.id
                                    ? "border-primary bg-accent text-accent-foreground"
                                    : "bg-background hover:bg-secondary"
                            }`}
                        >
                            <PaletteContext.Provider value={palette}>
                                <span className="flex gap-1">
                                    {CONCEPTS.map((concept) => (
                                        <Tile key={concept.id} concept={concept} size={22} />
                                    ))}
                                </span>
                            </PaletteContext.Provider>
                            {palette.name}
                        </button>
                    ))}
                </div>
                <div className="flex flex-wrap gap-6">
                    <Swatch label="Gradient start" color={selected.from} />
                    <Swatch label="Gradient end" color={selected.to} />
                    <Swatch label="Flat" color={selected.flat} />
                    <Swatch label="Glyph" color={selected.glyph} />
                </div>
            </div>
        </Section>
    );
}

function OriginalSection() {
    return (
        <Section
            title="Starting point"
            caption="The supplied icon. It is Apple's Intelligence mark, so it is reference only."
        >
            <div className="flex flex-wrap items-end gap-4">
                {[64, 32, 16].map((size) => (
                    <img key={size} src={ORIGINAL} width={size} height={size} alt="" />
                ))}
            </div>
        </Section>
    );
}

export function LogosPage() {
    const [palette, setPalette] = useState<Palette>(PALETTES[0]);
    return (
        <Page>
            <PageHeader
                title="Logos"
                caption="Five original marks from the same family: one continuous line on a warm tile. Prototype; not in the sidebar."
            />
            <PaletteSection selected={palette} onSelect={setPalette} />
            <PaletteContext.Provider value={palette}>
                {CONCEPTS.map((concept, index) => (
                    <ConceptRow key={concept.id} concept={concept} index={index} />
                ))}
            </PaletteContext.Provider>
            <OriginalSection />
        </Page>
    );
}
