import type { ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";

export function SettingsLayout({
    title,
    actions,
    children,
}: { title: string; actions?: ReactNode; children: ReactNode }) {
    return (
        <Page>
            <PageHeader title={title} actions={actions} />
            {children}
        </Page>
    );
}
