import { Link } from "obp-ui";
import type { ModelDetail } from "~/api/client";
import { usePresets } from "~/api/queries";
import { useCan } from "~/lib/access";
import { metricName } from "~/lib/metrics";
import { Inline } from "./header";
import { settingsHref } from "./settings";

const JUDGE = "judge";

export function ScoredBy({ detail }: { detail: ModelDetail | undefined }) {
    const presets = usePresets();
    const can = useCan();
    if (!detail) {
        return null;
    }
    const labels = new Map((presets.data?.graders ?? []).map((item) => [item.name, item.label]));
    const graders = detail.graders
        .map((item) => item.name)
        .filter((name) => name !== JUDGE)
        .map((name) => labels.get(name) ?? metricName(name));
    const judged = detail.graders.some((item) => item.name === JUDGE);
    return (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-4 text-muted-foreground">
            <Inline
                items={[
                    <span key="graders">
                        Scored by{" "}
                        <span className="text-foreground">
                            {graders.length > 0 ? graders.join(", ") : "no graders"}
                        </span>
                    </span>,
                    judged && (
                        <span key="judge">
                            judge <span className="text-foreground">{detail.judge.name}</span>
                        </span>
                    ),
                    can.build && (
                        <Link
                            key="change"
                            href={settingsHref(detail.slug)}
                            className="text-primary hover:underline"
                        >
                            Change in Settings
                        </Link>
                    ),
                ]}
            />
        </p>
    );
}
