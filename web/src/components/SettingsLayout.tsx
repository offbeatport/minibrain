import type { ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { useSettingsLanding } from "~/lib/settingsLanding";

export function SettingsLayout({
    title,
    actions,
    children,
}: { title: string; actions?: ReactNode; children: ReactNode }) {
    useSettingsLanding();
    return (
        <Page>
            <PageHeader title={title} actions={actions} />
            {children}
        </Page>
    );
}
