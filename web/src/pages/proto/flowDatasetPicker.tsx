import { CircleDashed, Database, type LucideIcon, Upload } from "lucide-react";
import { Label, RadioGroup, RadioGroupItem, cn, useToast } from "obp-ui";
import { count } from "~/lib/format";
import { type Dataset, useFlowState } from "./modelsFlowData";

const LATER = "later";

const ROW =
    "group/row flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 font-normal hover:bg-secondary has-data-checked:border-primary has-data-checked:bg-accent has-data-checked:hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring";

function Row({
    value,
    icon: Icon,
    title,
    meta,
}: {
    value: string;
    icon: LucideIcon;
    title: string;
    meta?: string;
}) {
    return (
        <Label className={ROW}>
            <RadioGroupItem value={value} className="sr-only" />
            <Icon
                aria-hidden
                className="size-5 shrink-0 text-muted-foreground group-has-data-checked/row:text-primary"
            />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{title}</span>
                {meta && (
                    <span className="truncate text-sm text-muted-foreground tabular-nums">
                        {meta}
                    </span>
                )}
            </span>
        </Label>
    );
}

function rowMeta(dataset: Dataset): string {
    return `${count(dataset.rows)} rows · v${dataset.version}`;
}

export function DatasetPicker({
    value,
    onChange,
    later = false,
    className,
}: {
    value: string | null;
    onChange: (slug: string | null) => void;
    later?: boolean;
    className?: string;
}) {
    const state = useFlowState();
    const toast = useToast();
    const upload = () =>
        toast({
            title: "Not in the prototype",
            description: "Would upload a CSV, JSONL or Parquet file as a new dataset.",
        });
    return (
        <div className="flex flex-col gap-2">
            <RadioGroup
                aria-label="Dataset"
                value={value ?? (later ? LATER : "")}
                onValueChange={(next) => onChange(next === LATER ? null : String(next))}
                className={cn("grid gap-2", className)}
            >
                {state.datasets.map((dataset) => (
                    <Row
                        key={dataset.slug}
                        value={dataset.slug}
                        icon={Database}
                        title={dataset.name}
                        meta={rowMeta(dataset)}
                    />
                ))}
                {later && (
                    <Row
                        value={LATER}
                        icon={CircleDashed}
                        title="Add later"
                        meta="Prompt-only v0"
                    />
                )}
            </RadioGroup>
            <button
                type="button"
                onClick={upload}
                className="flex w-fit items-center gap-2 rounded-md text-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
                <Upload aria-hidden className="size-4" />
                Upload new…
            </button>
        </div>
    );
}
