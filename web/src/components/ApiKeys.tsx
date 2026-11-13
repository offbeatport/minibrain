import { ArrowRight, KeyRound } from "lucide-react";
import { Button, Link } from "obp-ui";
import type { ReactNode } from "react";
import type { KeyCreated, ModelRef } from "~/api/client";
import { useKeys } from "~/api/queries";
import { ErrorLine, PanelSection } from "~/components/Section";
import { KeysTable, useKeyManager } from "~/components/keys/KeysTable";
import { keyCovers } from "~/components/keys/scope";
import { API_KEYS_PATH } from "~/lib/modelLinks";

export function ApiKeys({
    scope,
    onCreated,
    secretActions,
    description,
}: {
    scope: ModelRef;
    onCreated?: (key: KeyCreated) => void;
    secretActions?: ReactNode;
    description?: ReactNode;
}) {
    const list = useKeys();
    const manager = useKeyManager(onCreated, secretActions);
    const rows = (list.data ?? []).filter((key) => keyCovers(key, scope));
    return (
        <PanelSection
            icon={KeyRound}
            title="API keys"
            description={description}
            actions={
                <>
                    <Button variant="ghost" asChild>
                        <Link href={API_KEYS_PATH}>
                            All API keys
                            <ArrowRight aria-hidden="true" />
                        </Link>
                    </Button>
                    <Button onClick={() => manager.create([scope])}>
                        <KeyRound aria-hidden="true" />
                        Create key
                    </Button>
                </>
            }
            bare
        >
            <div className="flex flex-col gap-3">
                <ErrorLine error={list.error} onRetry={list.refetch} />
                <KeysTable
                    rows={rows}
                    loading={list.isLoading}
                    storageKey="minibrain.keys.model"
                    empty="No keys can call this model yet."
                    onEdit={manager.edit}
                    onRevoke={manager.revoke}
                />
            </div>
            {manager.dialogs}
        </PanelSection>
    );
}
