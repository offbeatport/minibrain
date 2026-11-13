import { Plug } from "lucide-react";
import { Button } from "obp-ui";
import { useState } from "react";
import type { KeyCreated, ModelDetail, ModelRow } from "~/api/client";
import { ApiKeys } from "~/components/ApiKeys";
import { FeedbackApi } from "~/components/FeedbackApi";
import { HarnessConfigs } from "~/components/HarnessConfigs";
import { RequestBodies } from "~/components/RequestBodies";
import { ModelSafety } from "~/components/SafetySettings";
import { PanelSection, PanelSections } from "~/components/Section";
import { useCan } from "~/lib/access";
import { ConnectDialog, isDeployed } from "./header";

function Endpoint({ row, keyValue }: { row: ModelRow; keyValue: string | null }) {
    const baseUrl = `${window.location.origin}/v1`;
    const pinned = row.kind === "custom" ? (row.current_version ?? row.ready_version) : null;
    return (
        <PanelSection
            icon={Plug}
            title="Endpoint"
            tip={
                isDeployed(row)
                    ? `OpenAI-compatible. Call it as ${row.key}${row.kind === "custom" ? `; ${row.key}@N pins version N` : ""}.`
                    : "Deploy it to call it from the API; keys can be created now."
            }
        >
            <div className="flex flex-col gap-4">
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                    <div className="flex min-w-0 flex-col gap-0.5">
                        <dt className="text-sm text-muted-foreground">Base URL</dt>
                        <dd className="truncate font-mono text-sm">{baseUrl}</dd>
                    </div>
                    <div className="flex min-w-0 flex-col gap-0.5">
                        <dt className="text-sm text-muted-foreground">Model</dt>
                        <dd className="truncate font-mono text-sm">{row.key}</dd>
                    </div>
                    {pinned !== null && pinned !== undefined && (
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <dt className="text-sm text-muted-foreground">One version</dt>
                            <dd className="truncate font-mono text-sm">{`${row.key}@${pinned}`}</dd>
                        </div>
                    )}
                </dl>
                <HarnessConfigs baseUrl={baseUrl} model={row.key} keyValue={keyValue} />
            </div>
        </PanelSection>
    );
}

export function KeysTab({ row, detail }: { row: ModelRow; detail: ModelDetail | undefined }) {
    const can = useCan();
    const [created, setCreated] = useState<KeyCreated | null>(null);
    const [connecting, setConnecting] = useState(false);
    const baseUrl = `${window.location.origin}/v1`;
    return (
        <PanelSections>
            {can.build && (
                <ApiKeys
                    scope={{ kind: row.kind, key: row.key }}
                    onCreated={setCreated}
                    secretActions={
                        <Button variant="outline" onClick={() => setConnecting(true)}>
                            <Plug aria-hidden="true" />
                            Connect
                        </Button>
                    }
                />
            )}
            <Endpoint row={row} keyValue={created?.secret ?? null} />
            {detail && (
                <FeedbackApi
                    baseUrl={baseUrl}
                    model={row.key}
                    slug={row.key}
                    kept={detail.request_bodies.kept}
                    keyValue={created?.secret ?? null}
                />
            )}
            {detail && <RequestBodies detail={detail} />}
            {detail && <ModelSafety detail={detail} />}
            <ConnectDialog
                row={row}
                open={connecting}
                onOpenChange={setConnecting}
                keyValue={created?.secret ?? null}
            />
        </PanelSections>
    );
}
