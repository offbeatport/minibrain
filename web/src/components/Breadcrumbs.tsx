import { ChevronRight } from "lucide-react";
import { Link } from "obp-ui";
import { Fragment } from "react";

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
    return (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
            {items.map((item, index) => (
                <Fragment key={item.label}>
                    {index > 0 && (
                        <ChevronRight aria-hidden="true" className="size-3.5 text-faint" />
                    )}
                    {item.href ? (
                        <Link
                            href={item.href}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                        >
                            {item.label}
                        </Link>
                    ) : (
                        <span aria-current="page">{item.label}</span>
                    )}
                </Fragment>
            ))}
        </nav>
    );
}
