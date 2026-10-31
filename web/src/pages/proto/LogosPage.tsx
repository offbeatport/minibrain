import { type CSSProperties, type ReactNode, createContext, useContext, useState } from "react";
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

function knotPath(): string {
    const points: string[] = [];
    const steps = 720;
    for (let index = 0; index < steps; index += 1) {
        const t = (4 * Math.PI * index) / steps;
        const radius = 30 + 7 * Math.cos((7 * t) / 2);
        const angle = t + 0.12;
        const x = 50 + radius * Math.sin(angle);
        const y = 50 - radius * Math.cos(angle);
        points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    return `M${points.join(" L")} Z`;
}

function squirclePath(): string {
    const points: string[] = [];
    const steps = 180;
    const exponent = 5;
    for (let index = 0; index < steps; index += 1) {
        const t = (2 * Math.PI * index) / steps;
        const cos = Math.cos(t);
        const sin = Math.sin(t);
        const x = 50 + 50 * Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
        const y = 50 + 50 * Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
        points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    return `M${points.join(" L")} Z`;
}

const KNOT = knotPath();
const SQUIRCLE = squirclePath();

function strokeFor(size: number): number {
    if (size >= 40) {
        return 4;
    }
    if (size >= 22) {
        return 5.6;
    }
    return 7.6;
}

function Glyph({ size, color = "currentColor" }: { size: number; color?: string }) {
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <path
                d={KNOT}
                fill="none"
                stroke={color}
                strokeWidth={strokeFor(size)}
                strokeLinejoin="round"
            />
        </svg>
    );
}

type TileStyle = "gradient" | "flat" | "cobalt" | "ink" | "paper";

function Tile({ size, style }: { size: number; style: TileStyle }) {
    const brand = useContext(PaletteContext);
    const id = `tile-${brand.id}-${style}-${size}`;
    const fills: Record<TileStyle, string> = {
        gradient: `url(#${id})`,
        flat: brand.flat,
        cobalt: "var(--primary)",
        ink: "var(--foreground)",
        paper: "var(--card)",
    };
    const glyph: Record<TileStyle, string> = {
        gradient: brand.glyph,
        flat: brand.glyph,
        cobalt: "var(--primary-foreground)",
        ink: "var(--background)",
        paper: brand.flat,
    };
    const inner = size >= 48 ? 0.74 : 0.86;
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <defs>
                <linearGradient id={id} x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" stopColor={brand.from} />
                    <stop offset="1" stopColor={brand.to} />
                </linearGradient>
            </defs>
            <path
                d={SQUIRCLE}
                fill={fills[style]}
                stroke={style === "paper" ? "var(--border)" : "none"}
                strokeWidth={1}
            />
            <g transform={`translate(${50 - 50 * inner} ${50 - 50 * inner}) scale(${inner})`}>
                <path
                    d={KNOT}
                    fill="none"
                    stroke={glyph[style]}
                    strokeWidth={strokeFor(size * inner)}
                    strokeLinejoin="round"
                />
            </g>
        </svg>
    );
}

function Wordmark({ className, style }: { className: string; style?: CSSProperties }) {
    return (
        <span className={`font-display font-semibold tracking-tight ${className}`} style={style}>
            minibrain
        </span>
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

const TILE_STYLES: { style: TileStyle; label: string }[] = [
    { style: "gradient", label: "Gradient" },
    { style: "flat", label: "Flat" },
    { style: "cobalt", label: "Cobalt (app primary)" },
    { style: "ink", label: "Ink" },
    { style: "paper", label: "Paper" },
];

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
        <Section title="Palette" caption="Click a palette to recolour every icon and lockup below.">
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
                                <Tile size={40} style="gradient" />
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
        <Section title="Original icon" caption="The supplied PNG at app-icon and favicon sizes.">
            <div className="flex flex-wrap items-end gap-4">
                {[128, 64, 48, 32, 16].map((size) => (
                    <div key={size} className="flex flex-col items-center gap-1.5">
                        <img src={ORIGINAL} width={size} height={size} alt="" />
                        <span className="font-mono text-sm text-muted-foreground tabular-nums">
                            {size}
                        </span>
                    </div>
                ))}
            </div>
        </Section>
    );
}

function TilesSection() {
    return (
        <Section
            title="Vector rebuild"
            caption="The knot redrawn as a vector so it can take any colour. The line thickens at small sizes to stay legible."
        >
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                {TILE_STYLES.map(({ style, label }) => (
                    <Cell key={style} label={label}>
                        <div className="flex items-end gap-3">
                            <Tile size={64} style={style} />
                            <Tile size={32} style={style} />
                            <Tile size={16} style={style} />
                        </div>
                    </Cell>
                ))}
            </div>
        </Section>
    );
}

function LockupsSection() {
    const brand = useContext(PaletteContext);
    return (
        <Section title="Lockups" caption="Icon and wordmark together.">
            <div className="grid gap-3 lg:grid-cols-2">
                <Cell label="Horizontal">
                    <div className="flex items-center gap-3 text-foreground">
                        <Tile size={56} style="gradient" />
                        <Wordmark className="text-4xl" />
                    </div>
                </Cell>
                <Cell label="Horizontal, glyph only">
                    <div className="flex items-center gap-3 text-foreground">
                        <Glyph size={56} color={brand.flat} />
                        <Wordmark className="text-4xl" />
                    </div>
                </Cell>
                <Cell label="Stacked">
                    <div className="mx-auto flex flex-col items-center gap-2 text-foreground">
                        <Tile size={72} style="gradient" />
                        <Wordmark className="text-2xl" />
                    </div>
                </Cell>
                <Cell label="Single colour">
                    <div className="flex items-center gap-3 text-foreground">
                        <Glyph size={48} />
                        <Wordmark className="text-3xl" />
                    </div>
                    <div className="flex items-center gap-3 text-primary">
                        <Glyph size={48} />
                        <Wordmark className="text-3xl" />
                    </div>
                </Cell>
                <Cell label="Inverse" className="bg-foreground" labelClassName="text-background">
                    <div className="flex items-center gap-3 text-background">
                        <Glyph size={48} />
                        <Wordmark className="text-3xl" />
                    </div>
                </Cell>
                <Cell label="Colour band" className="border-transparent">
                    <div
                        className="flex w-full items-center gap-3 rounded-md px-4 py-3"
                        style={{ background: brand.flat, color: brand.glyph }}
                    >
                        <Glyph size={40} />
                        <Wordmark className="text-2xl" />
                    </div>
                </Cell>
            </div>
        </Section>
    );
}

function ContextSection() {
    return (
        <Section title="In context" caption="How it reads where people will actually see it.">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Cell label="Sidebar header">
                    <div className="flex w-full items-center gap-2 rounded-md border bg-background px-3 py-2">
                        <Tile size={22} style="gradient" />
                        <span className="text-base font-semibold">minibrain</span>
                    </div>
                </Cell>
                <Cell label="Collapsed sidebar">
                    <div className="flex flex-col items-center gap-3 rounded-md border bg-background px-3 py-3">
                        <Tile size={28} style="gradient" />
                        <span className="h-4 w-4 rounded-sm bg-secondary" />
                        <span className="h-4 w-4 rounded-sm bg-secondary" />
                    </div>
                </Cell>
                <Cell label="Browser tab">
                    <div className="flex flex-col gap-2">
                        <div className="flex w-fit items-center gap-2 rounded-t-md border border-b-0 bg-card px-3 py-1.5">
                            <Tile size={16} style="gradient" />
                            <span className="text-sm">minibrain · Models</span>
                        </div>
                        <div className="flex w-fit items-center gap-2 rounded-t-md border border-b-0 bg-foreground px-3 py-1.5 text-background">
                            <Tile size={16} style="gradient" />
                            <span className="text-sm">minibrain · Models</span>
                        </div>
                    </div>
                </Cell>
                <Cell label="Dock">
                    <div className="flex items-end gap-2 rounded-lg border bg-secondary px-3 py-2">
                        <Tile size={44} style="ink" />
                        <Tile size={56} style="gradient" />
                        <Tile size={44} style="cobalt" />
                    </div>
                </Cell>
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
                caption="Variations on the knot icon. Prototype; not in the sidebar."
            />
            <PaletteSection selected={palette} onSelect={setPalette} />
            <PaletteContext.Provider value={palette}>
                <TilesSection />
                <LockupsSection />
                <ContextSection />
            </PaletteContext.Provider>
            <OriginalSection />
        </Page>
    );
}
