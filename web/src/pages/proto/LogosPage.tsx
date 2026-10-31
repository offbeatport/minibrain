import type { CSSProperties, ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";

const ORIGINAL = "/proto/knot-icon.png";

const BRAND = {
    from: "#ff3b22",
    to: "#ffa23f",
    flat: "#ff5a2a",
    cream: "#ffeadf",
};

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
    const id = `tile-${style}-${size}`;
    const fills: Record<TileStyle, string> = {
        gradient: `url(#${id})`,
        flat: BRAND.flat,
        cobalt: "var(--primary)",
        ink: "var(--foreground)",
        paper: "var(--card)",
    };
    const glyph: Record<TileStyle, string> = {
        gradient: BRAND.cream,
        flat: BRAND.cream,
        cobalt: "var(--primary-foreground)",
        ink: "var(--background)",
        paper: BRAND.flat,
    };
    const inner = size >= 48 ? 0.74 : 0.86;
    return (
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
            <defs>
                <linearGradient id={id} x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" stopColor={BRAND.from} />
                    <stop offset="1" stopColor={BRAND.to} />
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
    { style: "gradient", label: "Gradient (original colours)" },
    { style: "flat", label: "Flat orange" },
    { style: "cobalt", label: "Cobalt (app primary)" },
    { style: "ink", label: "Ink" },
    { style: "paper", label: "Paper" },
];

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
                        <Glyph size={56} color={BRAND.flat} />
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
                <Cell label="Orange band" className="border-transparent">
                    <div
                        className="flex w-full items-center gap-3 rounded-md px-4 py-3"
                        style={{ background: BRAND.flat, color: BRAND.cream }}
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
    return (
        <Page>
            <PageHeader
                title="Logos"
                caption="Variations on the knot icon. Prototype; not in the sidebar."
            />
            <OriginalSection />
            <TilesSection />
            <LockupsSection />
            <ContextSection />
        </Page>
    );
}
