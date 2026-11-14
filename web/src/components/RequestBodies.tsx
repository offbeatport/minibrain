import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Logs } from "lucide-react";
import {
    Badge,
    Link,
    SettingsGroup,
    SettingsRow,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { useEffect } from "react";
import { type ModelDetail, api, unwrap } from "~/api/client";
import { keys } from "~/api/queries";
import { PanelSection, errorMessage } from "~/components/Section";
import { useCan } from "~/lib/access";
import { REQUEST_BODIES_ID } from "~/lib/modelLinks";
import { REQUESTS_PATH } from "~/lib/requests";

type Reason = { label: string; detail: string };

const LOCKS: Record<string, Reason> = {
    ui: {
        label: "Locked for every model",
        detail: "An admin set Request inputs and answers for every model under Settings, Security.",
    },
    "config file": {
        label: "Set by config file",
        detail: "Set for every model in the server's minibrain.yaml, so it can only be changed there.",
    },
    environment: {
        label: "Set by environment",
        detail: "Set for every model by an environment variable on the server, so it can only be changed there.",
    },
};

const BUILDERS: Reason = {
    label: "Builders change it",
    detail: "Changing what this model keeps needs the Builder role.",
};

function ReasonBadge({ reason }: { reason: Reason }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="w-fit rounded-sm">
                    <Badge variant="neutral">{reason.label}</Badge>
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{reason.detail}</TooltipContent>
        </Tooltip>
    );
}

function useHashTarget(id: string) {
    const hash = useRouterState({ select: (state) => state.location.hash });
    useEffect(() => {
        if (hash.replace(/^#/, "") === id) {
            document.getElementById(id)?.scrollIntoView({ block: "center" });
        }
    }, [hash, id]);
}

export function RequestBodies({ detail }: { detail: ModelDetail }) {
    const client = useQueryClient();
    const can = useCan();
    const bodies = detail.request_bodies;
    const change = useMutation({
        mutationFn: (kept: boolean) =>
            unwrap(
                api.PUT("/api/models/{name}/request-bodies", {
                    params: { path: { name: detail.slug } },
                    body: { kept },
                }),
            ),
        onSuccess: async (next) => {
            client.setQueryData(keys.model(detail.slug), next);
            await client.invalidateQueries({ queryKey: ["audit"] });
        },
    });
    useHashTarget(REQUEST_BODIES_ID);
    const reason = bodies.locked ? LOCKS[bodies.source] : can.build ? undefined : BUILDERS;
    const requests = `${REQUESTS_PATH}?model=${encodeURIComponent(detail.slug)}`;
    return (
        <PanelSection
            icon={Logs}
            anchor="request-content"
            title="Request content"
            tip={
                <>
                    {"Every call is logged without its content; see them in "}
                    <Link href={requests} className="text-primary hover:underline">
                        Monitoring, Requests
                    </Link>
                    {". This decides whether the content is kept too."}
                </>
            }
        >
            <SettingsGroup>
                <SettingsRow
                    id={REQUEST_BODIES_ID}
                    toggle={reason === undefined}
                    disabled={reason !== undefined}
                    label="Keep request inputs and answers"
                    description="Stores each request's last user message and the model's answer with its log, so you can read real conversations, apps can send feedback with the response ID alone, and training can learn from real traffic. Deleted with the request logs."
                    error={errorMessage(change.error)}
                    control={
                        <>
                            <Switch
                                id={REQUEST_BODIES_ID}
                                checked={bodies.kept}
                                disabled={reason !== undefined}
                                readOnly={change.isPending}
                                onCheckedChange={(checked) => change.mutate(checked)}
                            />
                            {reason && <ReasonBadge reason={reason} />}
                        </>
                    }
                />
            </SettingsGroup>
        </PanelSection>
    );
}
