import { CircleDashed, Database, Upload } from "lucide-react";
import { useToast } from "obp-ui";
import { count } from "~/lib/format";
import { RichSelect } from "./flowSelect";
import { useFlowState } from "./modelsFlowData";

const LATER = "later";

export function DatasetPicker({
    value,
    onChange,
    later = false,
}: {
    value: string | null;
    onChange: (slug: string | null) => void;
    later?: boolean;
}) {
    const state = useFlowState();
    const toast = useToast();
    const upload = () =>
        toast({
            title: "Not in the prototype",
            description: "Would upload a CSV, JSONL or Parquet file as a new dataset.",
        });
    const options = [
        ...state.datasets.map((dataset) => ({
            value: dataset.slug,
            label: dataset.name,
            meta: `${count(dataset.rows)} rows · v${dataset.version}`,
            icon: <Database />,
        })),
        ...(later
            ? [
                  {
                      value: LATER,
                      label: "Add later",
                      meta: "prompt-only v0",
                      icon: <CircleDashed />,
                      separated: true,
                  },
              ]
            : []),
    ];
    return (
        <div className="flex flex-col gap-2">
            <RichSelect
                id="dataset"
                label="Dataset"
                value={value ?? (later ? LATER : null)}
                options={options}
                onChange={(next) => onChange(next === LATER ? null : next)}
                placeholder="Choose a dataset"
            />
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
