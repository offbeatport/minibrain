import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/motion/card";
import { cn } from "@/lib/utils";
import type { ReactNode, TextareaHTMLAttributes } from "react";

export function Section({
    title,
    caption,
    actions,
    children,
}: {
    title: string;
    caption?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <Card variant="outlined">
            <CardHeader>
                <CardTitle as="h2">{title}</CardTitle>
                {caption && <CardDescription>{caption}</CardDescription>}
                {actions && <CardAction className="flex items-center gap-2">{actions}</CardAction>}
            </CardHeader>
            <CardContent>{children}</CardContent>
        </Card>
    );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="min-w-24">
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="text-base font-medium tabular-nums">{value}</div>
        </div>
    );
}

export function ErrorLine({ error }: { error: unknown }) {
    if (!error) {
        return null;
    }
    return (
        <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : String(error)}
        </p>
    );
}

export function Page({ children }: { children: ReactNode }) {
    return <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6">{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">{label}</span>
            {children}
        </div>
    );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return (
        <textarea
            className={cn(
                "w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40",
                className,
            )}
            {...props}
        />
    );
}

export function CodeBlock({ children }: { children: string }) {
    return (
        <pre className="overflow-x-auto rounded-xl border border-border bg-card p-4 font-mono text-sm">
            {children}
        </pre>
    );
}

export function Progress({ value }: { value: number }) {
    return (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%` }}
            />
        </div>
    );
}

export type BubbleRole = "user" | "assistant" | "system";

export function Bubble({ role, children }: { role: BubbleRole; children: ReactNode }) {
    if (role === "system") {
        return (
            <p className="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                {children}
            </p>
        );
    }
    return (
        <div className={cn("flex", role === "user" ? "justify-end" : "justify-start")}>
            <div
                className={cn(
                    "max-w-[80%] rounded-2xl px-4 py-2 text-sm",
                    role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "border border-border bg-card font-mono text-foreground",
                )}
            >
                {children}
            </div>
        </div>
    );
}

export type LogKind = "info" | "ok" | "warn" | "error" | "plain";

const LOG_COLOR: Record<LogKind, string> = {
    info: "text-primary",
    ok: "text-success",
    warn: "text-warning",
    error: "text-destructive",
    plain: "text-muted-foreground",
};

export function LogPanel({
    lines,
    empty,
}: { lines: { text: string; kind: LogKind }[]; empty: string }) {
    return (
        <div className="max-h-64 overflow-y-auto rounded-xl border border-border bg-card p-3 font-mono text-sm">
            {lines.length === 0 ? (
                <p className="text-muted-foreground">{empty}</p>
            ) : (
                lines.map((line, index) => (
                    <p
                        key={`${index}-${line.text}`}
                        className={cn("whitespace-pre-wrap", LOG_COLOR[line.kind])}
                    >
                        {line.text}
                    </p>
                ))
            )}
        </div>
    );
}
