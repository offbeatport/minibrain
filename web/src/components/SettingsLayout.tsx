import type { ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";

export function SettingsLayout({ title, children }: { title: string; children: ReactNode }) {
    return (
        <Page>
            <PageHeader title={title} />
            {children}
        </Page>
    );
}
