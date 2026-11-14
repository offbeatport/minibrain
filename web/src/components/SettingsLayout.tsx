import type { ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { useSettingsLanding } from "~/lib/settingsLanding";

export function SettingsLayout({
    title,
    caption,
    actions,
    children,
}: { title: string; caption: ReactNode; actions?: ReactNode; children: ReactNode }) {
    useSettingsLanding();
    return (
        <Page>
            <PageHeader title={title} caption={caption} actions={actions} />
            {children}
        </Page>
    );
}
