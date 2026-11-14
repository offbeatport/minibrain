import { Plug } from "lucide-react";
import { Button } from "obp-ui";
import { useState } from "react";
import type { KeyCreated, ModelDetail, ModelRow } from "~/api/client";
import { ApiKeys } from "~/components/ApiKeys";
import { RequestBodies } from "~/components/RequestBodies";
import { ModelSafety } from "~/components/SafetySettings";
import { PanelSections } from "~/components/Section";
import { useCan } from "~/lib/access";
import { ConnectDialog } from "./connect";

export function KeysTab({ row, detail }: { row: ModelRow; detail: ModelDetail | undefined }) {
    const can = useCan();
    const [created, setCreated] = useState<KeyCreated | null>(null);
    const [connecting, setConnecting] = useState(false);
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
