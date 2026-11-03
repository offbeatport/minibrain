import { ChevronDown, ChevronUp } from "lucide-react";
import {
    type KeyboardEvent,
    type PointerEvent,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

const RESIZE_STEP = 16;

export type SortDirection = "asc" | "desc";
export type ColumnWidths = Record<string, number>;
export type ResizableColumn = { id: string; label: string; min: number; max: number };

function clamp(column: ResizableColumn, width: number): number {
    return Math.min(column.max, Math.max(column.min, Math.round(width)));
}

function readWidths(key: string, columns: ResizableColumn[]): ColumnWidths {
    try {
        const stored = JSON.parse(window.localStorage.getItem(key) ?? "{}");
        return Object.fromEntries(
            columns.flatMap((column) => {
                const value = stored?.[column.id];
                return typeof value === "number" && Number.isFinite(value)
                    ? [[column.id, clamp(column, value)]]
                    : [];
            }),
        );
    } catch {
        return {};
    }
}

function writeWidths(key: string, widths: ColumnWidths): void {
    try {
        window.localStorage.setItem(key, JSON.stringify(widths));
    } catch {
        return;
    }
}

export function useColumnWidths(storageKey: string, columns: ResizableColumn[]) {
    const [widths, setWidths] = useState<ColumnWidths>(() => readWidths(storageKey, columns));
    useEffect(() => writeWidths(storageKey, widths), [storageKey, widths]);
    const resize = (column: ResizableColumn, width: number) =>
        setWidths((current) => ({ ...current, [column.id]: clamp(column, width) }));
    const reset = (column: ResizableColumn) => setWidths(({ [column.id]: _, ...rest }) => rest);
    const resetAll = () => setWidths({});
    return { widths, resize, reset, resetAll };
}

export function widthVariables(widths: ColumnWidths, prefix: string): Record<string, string> {
    return Object.fromEntries(
        Object.entries(widths).map(([id, width]) => [`${prefix}${id}`, `${width}px`]),
    );
}

function useParentWidth() {
    const handle = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        const parent = handle.current?.parentElement;
        if (!parent) {
            return;
        }
        const observer = new ResizeObserver(() =>
            setWidth(Math.round(parent.getBoundingClientRect().width)),
        );
        observer.observe(parent);
        return () => observer.disconnect();
    }, []);
    return { handle, width };
}

export function LeadingResizer({
    column,
    onResize,
    onReset,
}: {
    column: ResizableColumn;
    onResize: (width: number) => void;
    onReset: () => void;
}) {
    const { handle, width } = useParentWidth();
    const [dragging, setDragging] = useState(false);
    const start = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const target = event.currentTarget;
        const from = target.parentElement?.getBoundingClientRect().width ?? width;
        const x = event.clientX;
        target.setPointerCapture(event.pointerId);
        setDragging(true);
        const move = (next: globalThis.PointerEvent) => onResize(from + x - next.clientX);
        const stop = () => {
            setDragging(false);
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", stop);
            target.removeEventListener("pointercancel", stop);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", stop);
        target.addEventListener("pointercancel", stop);
    };
    const step = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            onResize(width + (event.key === "ArrowLeft" ? RESIZE_STEP : -RESIZE_STEP));
        }
    };
    return (
        <div
            ref={handle}
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${column.label} column`}
            aria-valuenow={width}
            aria-valuemin={column.min}
            aria-valuemax={column.max}
            tabIndex={0}
            title="Drag to resize, double-click to reset"
            data-dragging={dragging || undefined}
            onPointerDown={start}
            onKeyDown={step}
            onDoubleClick={onReset}
            className="absolute inset-y-0 -left-4 z-10 w-4 cursor-col-resize touch-none select-none outline-none after:absolute after:inset-y-1 after:left-1/2 after:w-px after:bg-input hover:after:w-0.5 hover:after:bg-primary focus-visible:after:w-0.5 focus-visible:after:bg-primary data-[dragging]:after:w-0.5 data-[dragging]:after:bg-primary"
        />
    );
}

export function ariaSort(direction: SortDirection | null) {
    if (direction === null) {
        return undefined;
    }
    return direction === "asc" ? ("ascending" as const) : ("descending" as const);
}

export function SortButton({
    label,
    direction,
    onSort,
}: {
    label: string;
    direction: SortDirection | null;
    onSort: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onSort}
            className="inline-flex max-w-full items-center gap-1 rounded-sm font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
            <span className="truncate">{label}</span>
            {direction === "asc" && <ChevronUp aria-hidden="true" className="size-3.5 shrink-0" />}
            {direction === "desc" && (
                <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            {direction && (
                <span className="sr-only">
                    {direction === "asc" ? ", sorted ascending" : ", sorted descending"}
                </span>
            )}
        </button>
    );
}
