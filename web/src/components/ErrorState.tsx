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
import { PageHeader } from "~/components/PageHeader";
import { Page, errorMessage } from "~/components/Section";
import { navEntryFor } from "~/components/navigation";

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

function ErrorFooter({ code }: { code: string }) {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-panel py-3 font-mono text-sm text-muted-foreground @md:px-[calc(var(--panel-padding)*1.5)]">
            <span className="text-foreground">{code}</span>
            <span className="min-w-0 truncate">{pathname}</span>
        </div>
    );
}

export function ErrorState({
    icon: Icon,
    title,
    children,
    detail,
    primary,
    secondary,
    code,
    heading: Heading = "h1",
    className,
}: {
    icon: LucideIcon;
    title: string;
    children?: ReactNode;
    detail?: ReactNode;
    primary?: ErrorAction;
    secondary?: ErrorAction;
    code?: string;
    heading?: "h1" | "h2";
    className?: string;
}) {
    const titleId = useId();
    return (
        <section
            aria-labelledby={titleId}
            className={cn(
                "@container w-full max-w-2xl overflow-hidden rounded-xl border bg-card",
                Heading === "h1" && "mt-4",
                className,
            )}
        >
            <div className="flex flex-col gap-6 p-panel @md:p-[calc(var(--panel-padding)*1.5)]">
                <div className="grid size-11 place-items-center rounded-lg border bg-background">
                    <Icon aria-hidden="true" className="size-5.5 text-muted-foreground" />
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                    <Heading id={titleId} className="text-xl font-semibold">
                        {title}
                    </Heading>
                    {children && (
                        <p className="max-w-prose text-base text-muted-foreground">{children}</p>
                    )}
                    {detail && (
                        <div className="text-sm break-words text-muted-foreground">{detail}</div>
                    )}
                </div>
                {(primary || secondary) && (
                    <div className="flex flex-wrap items-center gap-2">
                        {primary && <ActionButton action={primary} primary />}
                        {secondary && <ActionButton action={secondary} primary={false} />}
                    </div>
                )}
            </div>
            {code && <ErrorFooter code={code} />}
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
            code="404 Not found"
            heading={heading}
        >
            {children}
        </ErrorState>
    );
}

export function ForbiddenState({
    needs,
    heading,
}: {
    needs: ReactNode;
    heading?: "h1" | "h2";
}) {
    return (
        <ErrorState
            icon={ShieldX}
            title="You don't have access"
            primary={GO_HOME}
            code="403 Forbidden"
            heading={heading}
        >
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
                heading={heading}
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
            code={isUnreachable(error) ? "No connection" : `Error ${status ?? ""}`.trim()}
            heading={heading}
        >
            {message}
        </ErrorState>
    );
}

export function ErrorPage({ fallback, children }: { fallback: string; children: ReactNode }) {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    return (
        <Page>
            <PageHeader title={navEntryFor(pathname)?.label ?? fallback} />
            {children}
        </Page>
    );
}

export function NotFoundPage() {
    return (
        <ErrorPage fallback="Page not found">
            <NotFoundState title="Nothing lives at this address" primary={GO_HOME} heading="h2">
                Check the address, or start again from Home.
            </NotFoundState>
        </ErrorPage>
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
        <ErrorPage fallback="Something went wrong">
            <ErrorState
                icon={TriangleAlert}
                title="This page hit an unexpected error"
                heading="h2"
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
                Reloading usually fixes it; your saved work is safe on the server.
            </ErrorState>
        </ErrorPage>
    );
}
