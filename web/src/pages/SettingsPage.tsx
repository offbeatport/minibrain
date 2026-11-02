import { GraduationCap, Palette, Split } from "lucide-react";
import { useInstallSettings } from "~/api/queries";
import { ErrorLine, PanelSection, PanelSections, Stat } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { ThemeChoice } from "~/components/ThemeChoice";
import { count } from "~/lib/format";

const SPLIT_LABELS: Record<string, string> = {
    golden: "Test set (max)",
    eval: "Held-out (max)",
    shots: "Few-shot (max)",
    min_rows: "Minimum rows",
};

function Appearance() {
    return (
        <PanelSection icon={Palette} title="Appearance">
            <ThemeChoice />
        </PanelSection>
    );
}

export function SettingsPage() {
    const { data, error } = useInstallSettings();
    return (
        <SettingsLayout>
            <ErrorLine error={error} />
            <PanelSections>
                <Appearance />
                <PanelSection icon={GraduationCap} title="Default training recipe">
                    <div className="flex flex-wrap gap-8">
                        {Object.entries(data?.recipe ?? {}).map(([key, value]) => (
                            <Stat
                                key={key}
                                label={key.replaceAll("_", " ")}
                                value={<span className="font-mono">{String(value)}</span>}
                            />
                        ))}
                    </div>
                </PanelSection>
                <PanelSection icon={Split} title="Dataset splits">
                    <div className="flex flex-wrap gap-8">
                        {Object.entries(data?.splits ?? {}).map(([key, value]) => (
                            <Stat key={key} label={SPLIT_LABELS[key] ?? key} value={count(value)} />
                        ))}
                    </div>
                </PanelSection>
            </PanelSections>
        </SettingsLayout>
    );
}
