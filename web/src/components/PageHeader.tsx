import {
    Button,
    EmptyState,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import type { ReactNode } from "react";
import type { MinibrainSummary } from "~/api/client";
import { Page } from "~/components/Section";
import { useSelectedMinibrain } from "~/lib/selection";

export function PageHeader({
    title,
    caption,
    actions,
}: {
    title: string;
    caption?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <header className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
                <h1 className="text-xl font-semibold">{title}</h1>
                {caption && <p className="text-sm text-muted-foreground">{caption}</p>}
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
    );
}

function MinibrainPicker({
    slug,
    minibrains,
    onSelect,
}: {
    slug: string;
    minibrains: MinibrainSummary[];
    onSelect: (slug: string) => void;
}) {
    return (
        <Select value={slug} onValueChange={(next) => onSelect(String(next ?? slug))}>
            <SelectTrigger className="w-56" aria-label="Minibrain">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {minibrains.map((item) => (
                    <SelectItem key={item.slug} value={item.slug}>
                        {item.name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

export function ScopedPage({
    title,
    caption,
    children,
}: {
    title: string;
    caption?: ReactNode;
    children: (slug: string) => ReactNode;
}) {
    const { slug, select, minibrains, loading } = useSelectedMinibrain();
    const picker = slug ? (
        <MinibrainPicker slug={slug} minibrains={minibrains} onSelect={select} />
    ) : null;
    return (
        <Page>
            <PageHeader title={title} caption={caption} actions={picker} />
            {!loading && !slug && (
                <EmptyState
                    variant="panel"
                    title="No minibrains yet"
                    action={
                        <Button asChild size="sm">
                            <Link href="/models">Create one on Models</Link>
                        </Button>
                    }
                >
                    Create a minibrain first, then come back here.
                </EmptyState>
            )}
            {slug && children(slug)}
        </Page>
    );
}

export function ComingSoon({
    title,
    caption,
    body,
}: { title: string; caption: string; body: string }) {
    return (
        <Page>
            <PageHeader title={title} caption={caption} />
            <EmptyState variant="panel" title="Coming next">
                {body}
            </EmptyState>
        </Page>
    );
}
