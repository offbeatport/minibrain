import { useRouterState } from "@tanstack/react-router";
import {
    ChevronRight,
    type LucideIcon,
    SearchX,
    ShieldX,
    TriangleAlert,
    WifiOff,
} from "lucide-react";
import { Button, Link, cn } from "obp-ui";
import { type ReactNode, useId } from "react";
import { errorStatus, isUnreachable } from "~/api/client";
import { Page, errorMessage } from "~/components/Section";

export type ErrorAction = { label: string; href?: string; onClick?: () => void };

export const GO_HOME: ErrorAction = { label: "Go home", href: "/" };

function ActionButton({ action, primary }: { action: ErrorAction; primary: boolean }) {
    const variant = primary ? "default" : "outline";
    if (action.href) {
        return (
            <Button asChild variant={variant}>
                <Link href={action.href}>{action.label}</Link>
            </Button>
        );
    }
    return (
        <Button variant={variant} onClick={action.onClick}>
            {action.label}
        </Button>
    );
}

export function ErrorState({
    icon: Icon,
    title,
    children,
    detail,
    primary,
    secondary,
    heading: Heading = "h1",
    className,
}: {
    icon: LucideIcon;
    title: string;
    children?: ReactNode;
    detail?: ReactNode;
    primary?: ErrorAction;
    secondary?: ErrorAction;
    heading?: "h1" | "h2";
    className?: string;
}) {
    const titleId = useId();
    return (
        <section
            aria-labelledby={titleId}
            className={cn(
                "@container w-full max-w-2xl rounded-xl border bg-card p-panel",
                className,
            )}
        >
            <div className="flex flex-col gap-3 @md:flex-row @md:items-start @md:gap-4">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
                    <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1 @md:pt-1.5">
                    <Heading id={titleId} className="text-lg font-semibold">
                        {title}
                    </Heading>
                    {children && <p className="text-base text-muted-foreground">{children}</p>}
                    {detail && (
                        <div className="text-sm break-words text-muted-foreground">{detail}</div>
                    )}
                    {(primary || secondary) && (
                        <div className="flex flex-wrap items-center gap-2 pt-3">
                            {primary && <ActionButton action={primary} primary />}
                            {secondary && <ActionButton action={secondary} primary={false} />}
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
}

export function NotFoundState({
    title,
    children,
    detail,
    primary,
    secondary,
    heading,
}: {
    title: string;
    children: ReactNode;
    detail?: ReactNode;
    primary: ErrorAction;
    secondary?: ErrorAction;
    heading?: "h1" | "h2";
}) {
    return (
        <ErrorState
            icon={SearchX}
            title={title}
            detail={detail}
            primary={primary}
            secondary={secondary}
            heading={heading}
        >
            {children}
        </ErrorState>
    );
}

export function ForbiddenState({ needs }: { needs: ReactNode }) {
    return (
        <ErrorState icon={ShieldX} title="You don't have access" primary={GO_HOME}>
            {needs}
        </ErrorState>
    );
}

export function QueryError({
    error,
    retry,
    notFound,
    heading,
}: {
    error: unknown;
    retry?: () => unknown;
    notFound?: ReactNode;
    heading?: "h1" | "h2";
}) {
    const message = errorMessage(error);
    if (!message) {
        return null;
    }
    const status = errorStatus(error);
    if (status === 404 && notFound) {
        return notFound;
    }
    if (status === 403) {
        return (
            <ForbiddenState
                needs={`${message}. Ask an admin to change your role under Settings, Accounts.`}
            />
        );
    }
    const again = retry ? { label: "Try again", onClick: () => void retry() } : undefined;
    return (
        <ErrorState
            icon={isUnreachable(error) ? WifiOff : TriangleAlert}
            title="Couldn't load this page"
            primary={again ?? GO_HOME}
            secondary={again ? GO_HOME : undefined}
            heading={heading}
        >
            {message}
        </ErrorState>
    );
}

export function NotFoundPage() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    return (
        <Page>
            <NotFoundState title="Page not found" primary={GO_HOME}>
                {"Nothing lives at "}
                <code className="font-mono">{pathname}</code>
                {". Check the address, or start again from Home."}
            </NotFoundState>
        </Page>
    );
}

function reload() {
    window.location.reload();
}

function goHome() {
    window.location.assign("/");
}

export function CrashPage({ error }: { error: unknown }) {
    const message = errorMessage(error) ?? "Unknown error";
    const stack = error instanceof Error ? error.stack : undefined;
    return (
        <Page>
            <ErrorState
                icon={TriangleAlert}
                title="Something went wrong"
                primary={{ label: "Reload", onClick: reload }}
                secondary={{ label: "Go home", onClick: goHome }}
                detail={
                    <details className="group mt-2 rounded-lg border bg-background">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
                            <ChevronRight
                                aria-hidden="true"
                                className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
                            />
                            Error details
                        </summary>
                        <pre className="max-h-64 overflow-auto border-t px-3 py-2 font-mono text-sm whitespace-pre-wrap text-foreground">
                            {stack ?? message}
                        </pre>
                    </details>
                }
            >
                This page hit an unexpected error. Reloading usually fixes it; your saved work is
                safe on the server.
            </ErrorState>
        </Page>
    );
}
