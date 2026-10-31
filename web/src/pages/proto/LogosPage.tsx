import type { ComponentType, ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";

type MarkProps = { size: number; mono?: boolean };

function accent(mono: boolean | undefined): string | undefined {
    return mono ? undefined : "text-primary";
}

function FoldMark({ size, mono }: MarkProps) {
    const detail = size >= 28;
    return (
        <svg
            viewBox="0 0 32 32"
            width={size}
            height={size}
            fill="none"
            stroke="currentColor"
            strokeWidth={detail ? 2.6 : 3.2}
            strokeLinecap="round"
            aria-hidden="true"
        >
            <path d="M5 26V15a5.5 5.5 0 0 1 11 0v11" />
            <path d="M16 15a5.5 5.5 0 0 1 11 0v11" className={accent(mono)} />
            {detail && <path d="M8.5 26v-9.5a2 2 0 0 1 4 0V26" />}
            {detail && <path d="M19.5 26v-9.5a2 2 0 0 1 4 0V26" className={accent(mono)} />}
        </svg>
    );
}

function DistilMark({ size, mono }: MarkProps) {
    return (
        <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
            <g transform="translate(1 2)">
                <path
                    d="M24.66 12.41A10 10 0 1 1 17.59 5.34"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                />
                <circle cx="24.4" cy="5.6" r="3.6" fill="currentColor" className={accent(mono)} />
            </g>
        </svg>
    );
}

function SignalMark({ size, mono }: MarkProps) {
    const inputs = [8, 16, 24];
    return (
        <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
            {inputs.map((y) => (
                <line
                    key={`edge-${y}`}
                    x1="7"
                    y1={y}
                    x2="24.5"
                    y2="16"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                />
            ))}
            {inputs.map((y) => (
                <circle key={`node-${y}`} cx="7" cy={y} r="3" fill="currentColor" />
            ))}
            <circle cx="24.5" cy="16" r="4.8" fill="currentColor" className={accent(mono)} />
        </svg>
    );
}

type Concept = {
    name: string;
    idea: string;
    Mark: ComponentType<MarkProps>;
};

const CONCEPTS: Concept[] = [
    {
        name: "Fold",
        idea: "A lowercase m whose arches nest like brain folds: two hemispheres, one of them specialised. Folds drop at small sizes.",
        Mark: FoldMark,
    },
    {
        name: "Distil",
        idea: "A large open ring with one dot drawn out of it: a big model distilled into a small, focused one.",
        Mark: DistilMark,
    },
    {
        name: "Signal",
        idea: "Three inputs, one output: the smallest network there is. One task, one answer.",
        Mark: SignalMark,
    },
];

function Cell({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-3 rounded-md border bg-background p-4">
            <span className="text-sm text-muted-foreground">{label}</span>
            <div className="flex flex-1 items-center">{children}</div>
        </div>
    );
}

function Wordmark({ className }: { className: string }) {
    return (
        <span className={`font-display font-semibold tracking-tight ${className}`}>minibrain</span>
    );
}

function Tile({ size, Mark }: { size: number; Mark: ComponentType<MarkProps> }) {
    return (
        <span
            className="grid place-items-center rounded-md bg-primary text-primary-foreground"
            style={{ width: size, height: size }}
        >
            <Mark size={Math.round(size * 0.78)} mono />
        </span>
    );
}

function ConceptRow({ concept, index }: { concept: Concept; index: number }) {
    const { Mark } = concept;
    return (
        <Section title={`${index + 1} · ${concept.name}`} caption={concept.idea}>
            <div className="grid gap-3 lg:grid-cols-[2fr_1fr_1fr]">
                <Cell label="Large">
                    <div className="flex items-center gap-4 text-foreground">
                        <Mark size={64} />
                        <Wordmark className="text-4xl" />
                    </div>
                </Cell>
                <Cell label="Small">
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2 text-foreground">
                            <Mark size={20} />
                            <Wordmark className="text-base" />
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <Mark size={16} mono />
                            <span className="text-sm">Powered by minibrain</span>
                        </div>
                    </div>
                </Cell>
                <Cell label="Favicon">
                    <div className="flex flex-col gap-3">
                        <div className="flex items-end gap-3">
                            <Tile size={48} Mark={Mark} />
                            <Tile size={32} Mark={Mark} />
                            <Tile size={16} Mark={Mark} />
                            <span className="text-foreground">
                                <Mark size={16} />
                            </span>
                        </div>
                        <div className="flex w-fit items-center gap-2 rounded-t-md border border-b-0 bg-card px-3 py-1.5">
                            <Tile size={16} Mark={Mark} />
                            <span className="text-sm">minibrain</span>
                        </div>
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
                caption="Three directions for the minibrain mark, each at large, small and favicon size. Prototype; not in the sidebar."
            />
            {CONCEPTS.map((concept, index) => (
                <ConceptRow key={concept.name} concept={concept} index={index} />
            ))}
        </Page>
    );
}
