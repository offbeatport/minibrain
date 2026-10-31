import {
    type ColumnDef,
    type SortingState,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "obp-ui";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";

const INTERACTIVE = "a, button, input, select, textarea, [role='menuitem']";

export function SortableTable<Row>({
    columns,
    rows,
    onOpen,
    rowLabel,
    empty,
    initialSort = [],
    minWidth = "min-w-[960px]",
}: {
    columns: ColumnDef<Row, unknown>[];
    rows: Row[];
    onOpen: (row: Row) => void;
    rowLabel: (row: Row) => string;
    empty: ReactNode;
    initialSort?: SortingState;
    minWidth?: string;
}) {
    const [sorting, setSorting] = useState<SortingState>(initialSort);
    const table = useReactTable({
        data: rows,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });
    const body = useRef<HTMLTableSectionElement>(null);
    const focusRow = (index: number) => {
        const rowsInBody = body.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]");
        rowsInBody?.[Math.max(0, Math.min(index, rowsInBody.length - 1))]?.focus();
    };
    const onKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: Row) => {
        if (
            event.target !== event.currentTarget &&
            (event.target as HTMLElement).closest(INTERACTIVE)
        ) {
            return;
        }
        const moves: Record<string, number> = {
            ArrowDown: index + 1,
            ArrowUp: index - 1,
            Home: 0,
            End: Number.MAX_SAFE_INTEGER,
        };
        if (event.key in moves) {
            event.preventDefault();
            focusRow(moves[event.key]);
        } else if (event.key === "Enter") {
            event.preventDefault();
            onOpen(row);
        }
    };
    const sortedRows = table.getRowModel().rows;
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table className={minWidth}>
                <TableHeader>
                    {table.getHeaderGroups().map((group) => (
                        <TableRow key={group.id}>
                            {group.headers.map((header) => {
                                const sorted = header.column.getIsSorted();
                                const title = flexRender(
                                    header.column.columnDef.header,
                                    header.getContext(),
                                );
                                return (
                                    <TableHead
                                        key={header.id}
                                        aria-sort={
                                            sorted === "asc"
                                                ? "ascending"
                                                : sorted === "desc"
                                                  ? "descending"
                                                  : undefined
                                        }
                                        className="whitespace-nowrap"
                                    >
                                        {header.column.getCanSort() ? (
                                            <button
                                                type="button"
                                                onClick={header.column.getToggleSortingHandler()}
                                                className="inline-flex items-center gap-1 rounded-sm font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                                            >
                                                {title}
                                                {sorted === "asc" && (
                                                    <ChevronUp className="size-3.5" />
                                                )}
                                                {sorted === "desc" && (
                                                    <ChevronDown className="size-3.5" />
                                                )}
                                            </button>
                                        ) : (
                                            title
                                        )}
                                    </TableHead>
                                );
                            })}
                        </TableRow>
                    ))}
                </TableHeader>
                <TableBody ref={body}>
                    {sortedRows.length === 0 ? (
                        <TableRow>
                            <TableCell colSpan={columns.length} className="py-8">
                                {empty}
                            </TableCell>
                        </TableRow>
                    ) : (
                        sortedRows.map((row, index) => (
                            <TableRow
                                key={row.id}
                                data-row
                                tabIndex={0}
                                aria-label={rowLabel(row.original)}
                                onKeyDown={(event) => onKey(event, index, row.original)}
                                className={cn("outline-none focus-visible:bg-secondary")}
                            >
                                {row.getVisibleCells().map((cell) => (
                                    <TableCell key={cell.id} className="py-2 align-middle">
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))
                    )}
                </TableBody>
            </Table>
        </div>
    );
}
