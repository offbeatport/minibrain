import type { ModelDetail, ModelRow, VersionInfo } from "~/api/client";
import { PanelSections } from "~/components/Section";
import { useCan } from "~/lib/access";
import { FailuresPanel } from "./failures";
import { ScoresPanel } from "./scores";
import { ScoringPanel } from "./scoring";
import { HeldOutPanel, TestExamplesPanel } from "./testedOn";

export function EvaluationTab({
    row,
    detail,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const can = useCan();
    return (
        <PanelSections>
            <ScoresPanel row={row} detail={detail} versions={versions} />
            {can.build && <FailuresPanel row={row} versions={versions} />}
            <HeldOutPanel row={row} detail={detail} versions={versions} />
            {can.build && detail && <TestExamplesPanel row={row} detail={detail} />}
            {can.build && detail && (
                <ScoringPanel
                    key={JSON.stringify([detail.graders, detail.judge, detail.promotion])}
                    row={row}
                    detail={detail}
                    versions={versions}
                />
            )}
        </PanelSections>
    );
}
