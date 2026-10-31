import { cn } from "obp-ui";
import type { ReactNode } from "react";

export type Tone = "success" | "info" | "warning" | "destructive" | "neutral";

const DOT: Record<Tone, string> = {
    success: "bg-success",
    info: "bg-info",
    warning: "bg-warning",
    destructive: "bg-destructive",
    neutral: "bg-faint",
};

export function StatusText({
    tone,
    children,
    className,
}: {
    tone: Tone;
    children: ReactNode;
    className?: string;
}) {
    return (
        <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
            {children}
        </span>
    );
}

export function ProgressBar({ value, label }: { value: number | null | undefined; label: string }) {
    if (value === null || value === undefined) {
        return (
            <span aria-hidden className="block h-1 w-24 overflow-hidden rounded-sm bg-secondary">
                <span className="block h-full w-1/3 animate-pulse bg-primary/70 motion-reduce:animate-none" />
            </span>
        );
    }
    return (
        <progress
            value={Math.round(value * 100)}
            max={100}
            aria-label={label}
            className="block h-1 w-24 appearance-none overflow-hidden rounded-sm bg-secondary [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-secondary [&::-webkit-progress-value]:bg-primary"
        />
    );
}
