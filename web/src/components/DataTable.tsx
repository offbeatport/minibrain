import { Table, type TableColumn } from "@/components/motion/table";

export type Column<Row> = TableColumn<Row>;

const HEADER_HEIGHT = 48;

export function DataTable<Row>({
    columns,
    rows,
    empty = "Nothing here yet.",
    rowHeight = 48,
    visibleRows = 10,
}: {
    columns: Column<Row>[];
    rows: Row[];
    empty?: string;
    rowHeight?: number;
    visibleRows?: number;
}) {
    const height = Math.max(1, Math.min(rows.length, visibleRows)) * rowHeight + HEADER_HEIGHT;
    return (
        <Table
            data={rows}
            columns={columns}
            rowHeight={rowHeight}
            height={height}
            emptyState={<p className="p-4 text-sm text-muted-foreground">{empty}</p>}
            className="rounded-xl"
        />
    );
}

export function Truncated({ text }: { text: string | null | undefined }) {
    const value = text ?? "–";
    return (
        <span className="block truncate" title={value}>
            {value}
        </span>
    );
}
