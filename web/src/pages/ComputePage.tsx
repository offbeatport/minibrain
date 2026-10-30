import type { ColumnDef } from "@tanstack/react-table";
import { useSystem } from "~/api/queries";
import type { components } from "~/api/schema";
import { DataTable } from "~/components/DataTable";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Section, Stat } from "~/components/Section";
import { count } from "~/lib/format";

type LoadedModel = components["schemas"]["LoadedModel"];

const JOB_STATES = ["queued", "running", "cancelling", "done", "failed", "cancelled"];

const LOADED_COLUMNS: ColumnDef<LoadedModel, unknown>[] = [
    {
        header: "Base model",
        accessorKey: "base_model",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Device",
        accessorKey: "device",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Adapters",
        id: "adapters",
        cell: ({ row }) => (
            <span className="font-mono">
                {row.original.adapters.length ? row.original.adapters.join(", ") : "–"}
            </span>
        ),
    },
];

function gigabytes(megabytes: number | null | undefined): string {
    return megabytes === null || megabytes === undefined
        ? "–"
        : `${(megabytes / 1024).toFixed(1)} GB`;
}

export function ComputePage() {
    const { data, error } = useSystem();
    const device = data?.device;
    return (
        <Page>
            <PageHeader
                title="Compute"
                caption="The hardware this install runs on and what it is doing now."
            />
            <ErrorLine error={error} />
            <Section
                title="Devices"
                caption="Inference uses the GPU when there is one; training avoids the Apple GPU, which hangs."
            >
                <div className="flex flex-wrap gap-8">
                    <Stat
                        label="Inference"
                        value={<span className="font-mono">{device?.inference ?? "–"}</span>}
                    />
                    <Stat
                        label="Training"
                        value={<span className="font-mono">{device?.training ?? "–"}</span>}
                    />
                    <Stat label="Accelerator" value={device?.accelerator ?? "None"} />
                    <Stat
                        label="GPU memory used"
                        value={`${gigabytes(device?.memory_used_mb)} of ${gigabytes(device?.memory_total_mb)}`}
                    />
                    <Stat label="CPU cores" value={count(device?.cpu_count)} />
                </div>
            </Section>
            <Section title="Job queue" caption="One worker runs jobs one at a time.">
                <div className="flex flex-wrap gap-8">
                    {JOB_STATES.map((state) => (
                        <Stat
                            key={state}
                            label={state[0].toUpperCase() + state.slice(1)}
                            value={count(data?.jobs[state] ?? 0)}
                        />
                    ))}
                </div>
            </Section>
            <Section
                title="Loaded in memory"
                caption="Base models and adapters the serving process holds right now."
            >
                <DataTable
                    columns={LOADED_COLUMNS}
                    rows={data?.loaded ?? []}
                    empty="Nothing loaded yet; the first request loads the base model."
                />
            </Section>
            <Section title="Libraries">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    {Object.entries(data?.libraries ?? {}).map(([name, version]) => (
                        <span key={name}>
                            {name} <span className="font-mono">{version}</span>
                        </span>
                    ))}
                </div>
            </Section>
        </Page>
    );
}
