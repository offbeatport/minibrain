import { Database, Upload } from "lucide-react";
import { useToast } from "obp-ui";
import { count } from "~/lib/format";
import { RichSelect } from "./flowSelect";
import { useFlowState } from "./modelsFlowData";

export function DatasetPicker({
    value,
    onChange,
}: {
    value: string | null;
    onChange: (slug: string | null) => void;
}) {
    const state = useFlowState();
    const toast = useToast();
    const upload = () =>
        toast({
            title: "Not in the prototype",
            description: "Would upload a CSV, JSONL or Parquet file as a new dataset.",
        });
    const options = state.datasets.map((dataset) => ({
        value: dataset.slug,
        label: dataset.name,
        meta: `${count(dataset.rows)} rows · v${dataset.version}`,
        icon: <Database />,
    }));
    return (
        <div className="flex flex-col gap-2">
            <RichSelect
                id="dataset"
                label="Dataset"
                value={value}
                options={options}
                onChange={onChange}
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
