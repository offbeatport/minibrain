import { SoftwareLogo, softwareIdFor } from "obp-ui";
import type { ReactNode } from "react";
import { initialOf } from "~/lib/access";

export function SoftwareMark({ name, fallback }: { name: string; fallback?: ReactNode }) {
    const id = softwareIdFor(name);
    return (
        <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-background [&>svg]:size-4"
        >
            {id ? (
                <SoftwareLogo id={id} />
            ) : (
                (fallback ?? (
                    <span className="text-sm font-semibold text-muted-foreground">
                        {initialOf(name)}
                    </span>
                ))
            )}
        </span>
    );
}
