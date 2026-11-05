import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "obp-ui";
import type { VersionInfo } from "~/api/client";
import { useModel } from "~/api/queries";
import { ChangeNotice } from "./DatasetVersions";
import { compareParam } from "./VersionDiff";
import { itemHref } from "./catalogue";

function previousOf(version: VersionInfo, versions: VersionInfo[]): VersionInfo | undefined {
    return versions
        .filter((item) => item.number < version.number)
        .sort((left, right) => right.number - left.number)[0];
}

export function datasetVersionDiffHref(before: VersionInfo, after: VersionInfo): string | null {
    const dataset = after.dataset_slug ?? before.dataset_slug;
    if (!dataset || !before.dataset_version_id || !after.dataset_version_id) {
        return null;
    }
    return `${itemHref({ kind: "dataset", id: dataset })}&compare=${compareParam(before.dataset_version_id, after.dataset_version_id)}`;
}

function AccuracyChange({ version, previous }: { version: VersionInfo; previous?: VersionInfo }) {
    const now = version.score;
    const then = previous?.main_metric === version.main_metric ? previous?.score : null;
    if (now === undefined || then === undefined || now === null || then === null) {
        return <span className="text-muted-foreground">–</span>;
    }
    const points = ((now - then) * 100).toFixed(1);
    if (points === "0.0" || points === "-0.0") {
        return <span className="text-muted-foreground tabular-nums">Same</span>;
    }
    return now > then ? (
        <span className="text-success tabular-nums">{`+${points} pts`}</span>
    ) : (
        <span className="text-destructive tabular-nums">{`−${points.replace("-", "")} pts`}</span>
    );
}

function DataChange({ version, previous }: { version: VersionInfo; previous?: VersionInfo }) {
    if (!previous) {
        return <span className="text-muted-foreground">–</span>;
    }
    if (previous.dataset_version_id === version.dataset_version_id) {
        return <span className="text-muted-foreground">Same data</span>;
    }
    const href = datasetVersionDiffHref(previous, version);
    return href ? (
        <Link href={href} className="text-primary hover:underline">
            {`Compare with v${previous.number}`}
        </Link>
    ) : (
        <span className="text-muted-foreground">Other data</span>
    );
}

export function withDataColumns(
    columns: ColumnDef<VersionInfo, unknown>[],
    versions: VersionInfo[],
): ColumnDef<VersionInfo, unknown>[] {
    const extra: ColumnDef<VersionInfo, unknown>[] = [
        {
            header: "vs previous",
            id: "change",
            cell: ({ row }) => (
                <AccuracyChange
                    version={row.original}
                    previous={previousOf(row.original, versions)}
                />
            ),
        },
        {
            header: "Data",
            id: "data",
            cell: ({ row }) => (
                <DataChange version={row.original} previous={previousOf(row.original, versions)} />
            ),
        },
    ];
    const created = columns.findIndex((column) => column.id === "created");
    const at = created < 0 ? columns.length : created;
    return [...columns.slice(0, at), ...extra, ...columns.slice(at)];
}

export function ModelDataNotice({ slug }: { slug: string }) {
    const detail = useModel(slug);
    return (
        <ChangeNotice
            changed={detail.data?.changed}
            datasetVersion={detail.data?.dataset_version}
            dataset={detail.data?.dataset}
            after="New versions train on it until the dataset is updated."
        />
    );
}

export function DataVersus({
    versions,
    number,
    against,
}: {
    versions: VersionInfo[] | undefined;
    number: number;
    against: number | undefined;
}) {
    const version = versions?.find((item) => item.number === number);
    const other = versions?.find((item) => item.number === against);
    if (!version || !other || other.number === version.number) {
        return <span className="text-muted-foreground">–</span>;
    }
    if (other.dataset_version_id === version.dataset_version_id) {
        return <span className="font-normal text-muted-foreground">Same data</span>;
    }
    const [before, after] = other.number < version.number ? [other, version] : [version, other];
    const href = datasetVersionDiffHref(before, after);
    return href ? (
        <Link href={href} className="font-normal text-primary hover:underline">
            Compare data
        </Link>
    ) : (
        <span className="font-normal text-muted-foreground">Other data</span>
    );
}
