import { SegmentedTabs, type ThemePref, getThemePref, setThemePref } from "obp-ui";
import { useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";

const MODES: { key: ThemePref; label: string }[] = [
    { key: "light", label: "Light" },
    { key: "dark", label: "Dark" },
    { key: "system", label: "System" },
];

function isThemePref(value: string): value is ThemePref {
    return MODES.some((mode) => mode.key === value);
}

export function PreferencesPage() {
    const [mode, setMode] = useState<ThemePref>(getThemePref());
    const choose = (key: string) => {
        if (isThemePref(key)) {
            setThemePref(key);
            setMode(key);
        }
    };
    return (
        <Page>
            <PageHeader title="Preferences" caption="Stored in this browser." />
            <Section title="Appearance" caption="Pick light, dark or follow the system.">
                <SegmentedTabs tabs={MODES} active={mode} onSelect={choose} />
            </Section>
        </Page>
    );
}
