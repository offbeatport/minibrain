import { Plug } from "lucide-react";
import { Button } from "obp-ui";
import { useState } from "react";
import type { KeyCreated, ModelRow } from "~/api/client";
import { ApiKeys } from "~/components/ApiKeys";
import { PanelSections } from "~/components/Section";
import { useCan } from "~/lib/access";
import { ConnectDialog } from "./connect";

export function KeysTab({ row }: { row: ModelRow }) {
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
            <ConnectDialog
                row={row}
                open={connecting}
                onOpenChange={setConnecting}
                keyValue={created?.secret ?? null}
            />
        </PanelSections>
    );
}
