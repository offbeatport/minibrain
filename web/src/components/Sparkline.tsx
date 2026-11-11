import { Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";

export type SparkPoint = { key: string; label: string; value: number; marked?: boolean };

const DOT = 4;

function placed(points: SparkPoint[], width: number, height: number) {
    const values = points.map((point) => point.value);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const pad = Math.max((high - low) * 0.12, 0.005);
    const range = high - low + pad * 2;
    const inner = height - DOT * 2;
    const step = points.length > 1 ? (width - DOT * 2) / (points.length - 1) : 0;
    return points.map((point, index) => ({
        ...point,
        x: points.length > 1 ? DOT + index * step : width / 2,
        y: DOT + inner - ((point.value - (low - pad)) / range) * inner,
    }));
}

export function Sparkline({
    points,
    width,
    height,
    label,
    format,
    className,
}: {
    points: SparkPoint[];
    width: number;
    height: number;
    label: string;
    format: (value: number) => string;
    className?: string;
}) {
    if (points.length === 0) {
        return null;
    }
    const spots = placed(points, width, height);
    const path = spots.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
    const column = width / spots.length;
    const summary = points.map((point) => `${point.label} ${format(point.value)}`).join(", ");
    return (
        <span
            role="img"
            aria-label={`${label}: ${summary}`}
            className={cn("relative inline-block shrink-0", className)}
            style={{ width, height }}
        >
            <svg
                aria-hidden="true"
                width={width}
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                className="block overflow-visible"
            >
                <polyline
                    points={path}
                    fill="none"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    className="stroke-[var(--chart-series-1)]"
                />
                {spots
                    .filter((point) => point.marked)
                    .map((point) => (
                        <circle
                            key={point.key}
                            cx={point.x}
                            cy={point.y}
                            r={DOT}
                            strokeWidth={2}
                            className="fill-primary stroke-card"
                        />
                    ))}
            </svg>
            {spots.map((point, index) => (
                <Tooltip key={point.key}>
                    <TooltipTrigger asChild>
                        <span
                            aria-hidden="true"
                            className="group/spark absolute top-0 h-full"
                            style={{ left: index * column, width: column }}
                        >
                            <span
                                className="absolute size-2 rounded-full bg-foreground opacity-0 ring-2 ring-card group-hover/spark:opacity-100"
                                style={{ left: point.x - index * column - DOT, top: point.y - DOT }}
                            />
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        <span className="tabular-nums">
                            <span className="font-semibold">{format(point.value)}</span>
                            {` · ${point.label}`}
                        </span>
                    </TooltipContent>
                </Tooltip>
            ))}
        </span>
    );
}
