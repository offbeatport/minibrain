import type { ReactNode } from "react";
import { type Role, usePerson } from "~/api/authQueries";
import { ErrorPage, ForbiddenState } from "~/components/ErrorState";
import { ROLE_LABELS, allows } from "~/lib/access";

export function NeedsRole({ role, children }: { role: Role; children: ReactNode }) {
    const person = usePerson();
    if (allows(person?.role, role)) {
        return children;
    }
    return (
        <ErrorPage fallback="No access">
            <ForbiddenState
                heading="h2"
                needs={`This page needs the ${ROLE_LABELS[role]} role. Ask an admin to change your role under Settings, Accounts.`}
            />
        </ErrorPage>
    );
}
