import { Database, Plus } from "lucide-react";
import { Button, InfoTip, Link } from "obp-ui";
import { type ReactNode, useState } from "react";
import type { ModelDetail, ModelRow, VersionInfo } from "~/api/client";
import { useTestExamples } from "~/api/feedbackQueries";
import { FormRow, FormRows } from "~/components/FormRows";
import { FLUSH_GRID, PanelSection } from "~/components/Section";
import { TestExamples } from "~/components/TestExamples";
import { useCan } from "~/lib/access";
import { count } from "~/lib/format";
import { playgroundHref } from "~/lib/modelLinks";
import { datasetHref } from "../about";
import { AddExampleDialog } from "./addExample";
import { scoredVersions } from "./scores";

function Muted({ children }: { children: ReactNode }) {
    return <span className="text-muted-foreground">{children}</span>;
}

function datasetLabel(detail: ModelDetail, number: number | null | undefined): string {
    const name = detail.dataset_name ?? detail.dataset ?? "Dataset";
    return number === null || number === undefined ? name : `${name} v${number}`;
}

function HeldOutRows({
    detail,
    versions,
}: {
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const latest = scoredVersions(versions).at(-1);
    const current = detail?.dataset_version;
    const held = latest?.held_out?.examples ?? null;
    const newer =
        current && latest && current.number !== latest.dataset_version_number ? current : null;
    return (
        <FormRows>
            <FormRow label="Held-out rows">
                {latest && held !== null ? (
                    <span className="tabular-nums">
                        {`${count(held)} rows scored v${latest.number}`}
                    </span>
                ) : (
                    <Muted>No version scored yet</Muted>
                )}
            </FormRow>
            <FormRow label="Dataset">
                {detail?.dataset ? (
                    <Link
                        href={datasetHref(detail.dataset)}
                        className="text-primary hover:underline"
                    >
                        {datasetLabel(detail, latest?.dataset_version_number ?? current?.number)}
                    </Link>
                ) : (
                    <Muted>None</Muted>
                )}
            </FormRow>
            {newer && detail && (
                <FormRow
                    label="Newer data"
                    tip="The next version is made from it and scored on its held-out rows."
                >
                    <span className="tabular-nums">
                        {`${datasetLabel(detail, newer.number)} · ${count(newer.counts.eval ?? 0)} held out`}
                    </span>
                </FormRow>
            )}
        </FormRows>
    );
}

function ExamplesBlock({ row }: { row: ModelRow }) {
    const examples = useTestExamples(row.key);
    const total = examples.data?.length ?? 0;
    return (
        <div id="test-examples" className="flex scroll-my-24 flex-col border-t">
            <div className="flex items-center gap-2 px-panel py-3">
                <h3 className="font-medium">Test examples</h3>
                <InfoTip label="About test examples" side="right">
                    Inputs with the answer they should get, added here or saved from the Playground.
                    Each joins the held-out rows of the next version's data.
                </InfoTip>
                {total > 0 && (
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {`${count(total)} join the next version's held-out rows`}
                    </span>
                )}
            </div>
            <div className={FLUSH_GRID}>
                <TestExamples slug={row.key} />
            </div>
        </div>
    );
}

export function TestedOnPanel({
    row,
    detail,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const can = useCan();
    const [adding, setAdding] = useState(false);
    const builds = can.build && detail !== undefined;
    return (
        <PanelSection
            icon={Database}
            anchor="tested-on"
            title="What it's tested on"
            tip="Held-out rows are set aside when a dataset version is made: no version trains on them, and every version made from it is scored on the same rows. Test examples join them."
            actions={
                builds && (
                    <>
                        <Button asChild variant="outline">
                            <Link href={playgroundHref(row.key)}>From the Playground</Link>
                        </Button>
                        <Button variant="outline" onClick={() => setAdding(true)}>
                            <Plus aria-hidden="true" />
                            Add test example
                        </Button>
                    </>
                )
            }
            flush
        >
            <div className="p-panel">
                <HeldOutRows detail={detail} versions={versions} />
            </div>
            {builds && <ExamplesBlock row={row} />}
            {builds && <AddExampleDialog detail={detail} open={adding} onOpenChange={setAdding} />}
        </PanelSection>
    );
}
