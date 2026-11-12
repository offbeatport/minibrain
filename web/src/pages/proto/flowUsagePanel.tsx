import { ChartLine } from "lucide-react";
import { PanelSection } from "~/components/Section";
import { usageOf, useUsageRange } from "./flowUsage";
import { UsageChart, ms, rate } from "./flowUsageChart";
import { type FlowModel, useFlowState } from "./modelsFlowData";

export function UsagePanel({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const keys = state.keys[model.slug] ?? [];
    const [range, setRange] = useUsageRange();
    const usage = usageOf(model, range, "requests", keys);
    const empty = usageOf(model, "30d", "requests", keys).total === 0;
    const replicas = model.replicas.length;
    return (
        <PanelSection
            icon={ChartLine}
            title="Usage"
            description={
                model.kind === "base"
                    ? "Requests to its deployed variants, by format."
                    : "Requests to the live model, by version."
            }
        >
            <div className="flex min-w-0 flex-col gap-4">
                <UsageChart
                    load={(metric) => usageOf(model, range, metric, keys)}
                    range={range}
                    onRange={setRange}
                    subject={model.name}
                    by={model.kind === "base" ? null : "by version"}
                    empty={empty}
                    emptyHint={model.deployed ? null : "Deploy to start receiving requests"}
                />
                <p className="text-sm text-muted-foreground tabular-nums">
                    {`${empty ? "No traffic" : `p95 ${ms(usage.p95)} · ${rate(usage.errors)} errors`} · ${replicas} ${replicas === 1 ? "replica" : "replicas"}${replicas > 0 ? ` on ${model.replicas.join(", ")}` : ""}`}
                </p>
            </div>
        </PanelSection>
    );
}
