import { Badge } from "obp-ui";
import { Fragment, type ReactElement, type ReactNode } from "react";
import { StatusText } from "~/components/models/StatusText";
import { modelPhase, useCompute, useNow } from "./flowCompute";
import { ModelHeaderActions } from "./flowModelActions";
import { type FlowModel, liveVersion, pct, useFlowState } from "./modelsFlowData";
import { ModelAvatar } from "./modelsFlowParts";

export type Fact = ReactElement | null | false;

export function Inline({ items }: { items: Fact[] }) {
    const shown = items.filter((item): item is ReactElement => Boolean(item));
    return (
        <>
            {shown.map((item, index) => (
                <Fragment key={item.key}>
                    {index > 0 && (
                        <span aria-hidden="true" className="text-faint">
                            ·
                        </span>
                    )}
                    {item}
                </Fragment>
            ))}
        </>
    );
}

export function CompactHeader({
    icon,
    title,
    facts,
    subtitle,
    actions,
}: {
    icon?: ReactNode;
    title: ReactNode;
    facts?: Fact[];
    subtitle?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <header className="flex flex-wrap items-center gap-4 py-4">
            {icon}
            <div className="flex min-w-64 flex-1 flex-col gap-1">
                <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
                    <h1 className="text-2xl leading-tight font-normal">{title}</h1>
                    {facts && (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
                            <Inline items={facts} />
                        </div>
                    )}
                </div>
                {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
    );
}

function liveText(model: FlowModel): string | null {
    const live = liveVersion(model);
    if (!live) {
        return null;
    }
    if (model.canary) {
        return `v${live.number} ${100 - model.canary.share}% · v${model.canary.version} ${model.canary.share}%`;
    }
    return `v${live.number} live ${pct(live.scores?.[0])}`;
}

function trimmed(text: string): string {
    return text.replace(/\.$/, "");
}

export function ModelHeader({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const now = useNow(500);
    const phase = modelPhase(model, state, compute, now);
    const custom = model.kind === "custom";
    const subtitle = custom
        ? [model.description ? trimmed(model.description) : null, `On ${model.base}`]
              .filter(Boolean)
              .join(" · ")
        : [model.publisher, model.size, model.licence].filter(Boolean).join(" · ");
    return (
        <CompactHeader
            icon={<ModelAvatar model={model} size="lg" />}
            title={model.name}
            facts={[
                <Badge key="kind" variant="outline">
                    {custom ? "Custom" : "Base"}
                </Badge>,
                <StatusText key="phase" tone={phase.tone}>
                    {phase.text}
                </StatusText>,
                custom && liveVersion(model) ? <span key="live">{liveText(model)}</span> : null,
            ]}
            subtitle={subtitle}
            actions={<ModelHeaderActions model={model} />}
        />
    );
}
