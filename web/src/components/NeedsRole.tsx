import { useRouterState } from "@tanstack/react-router";
import { EmptyState } from "obp-ui";
import type { ReactNode } from "react";
import { type Role, usePerson } from "~/api/authQueries";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { navEntryFor } from "~/components/navigation";
import { ROLE_LABELS, allows } from "~/lib/access";

export function NeedsRole({ role, children }: { role: Role; children: ReactNode }) {
    const person = usePerson();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    if (allows(person?.role, role)) {
        return children;
    }
    return (
        <Page>
            <PageHeader title={navEntryFor(pathname)?.label ?? "Not available"} />
            <EmptyState variant="panel" title={`This page needs the ${ROLE_LABELS[role]} role`}>
                Ask an admin to change your role under Settings, Accounts.
            </EmptyState>
        </Page>
    );
}
