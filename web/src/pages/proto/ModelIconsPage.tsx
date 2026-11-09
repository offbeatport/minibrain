import { ThemeToggle } from "obp-ui";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { AvatarStyles } from "./AvatarStylesSection";

export function ModelIconsPage() {
    return (
        <Page wide>
            <PageHeader
                title="Model icons"
                caption="Four avatar styles for a custom model, each in the publisher-logo frame with a theme tone stored by name. Prototype; not in the sidebar."
                actions={<ThemeToggle />}
            />
            <AvatarStyles />
        </Page>
    );
}
