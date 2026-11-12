import { KeyRound, ListFilter } from "lucide-react";
import { Button, CheckboxSelect, SearchInput } from "obp-ui";
import type { KeyInfo } from "~/api/client";
import { useKeys } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page } from "~/components/Section";
import { KeysTable, useKeyManager } from "~/components/keys/KeysTable";
import { useCan } from "~/lib/access";
import { splitList, useListSearch } from "~/lib/listSearch";
import { API_KEYS_PATH } from "~/lib/modelLinks";

const KEYS = ["scope", "q"] as const;

type ScopeKind = "all" | "models" | "none";

const SCOPES: { value: ScopeKind; label: string }[] = [
    { value: "all", label: "All models" },
    { value: "models", label: "Specific models" },
    { value: "none", label: "No access" },
];

function scopeOf(key: KeyInfo): ScopeKind {
    if (key.all_models) {
        return "all";
    }
    return key.models.length > 0 ? "models" : "none";
}

function matches(key: KeyInfo, query: string): boolean {
    const wanted = query.trim().toLowerCase();
    if (!wanted) {
        return true;
    }
    const haystack = [
        key.name,
        key.prefix,
        key.created_by ?? "",
        ...key.models.flatMap((model) => [model.name, model.key]),
    ];
    return haystack.some((value) => value.toLowerCase().includes(wanted));
}

type Manager = ReturnType<typeof useKeyManager>;

function KeyList({ manager }: { manager: Manager }) {
    const list = useKeys();
    const { search, update } = useListSearch(API_KEYS_PATH, KEYS);
    const scopes = splitList(search.scope);
    const all = list.data ?? [];
    const rows = all.filter(
        (key) =>
            (scopes.length === 0 || scopes.includes(scopeOf(key))) && matches(key, search.q ?? ""),
    );
    const filtering = scopes.length > 0 || Boolean(search.q);
    const clear = () => update({ scope: "", q: "" });
    const options = SCOPES.map((scope) => ({
        ...scope,
        count: all.filter((key) => scopeOf(key) === scope.value).length,
    }));
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                    aria-label="Search keys"
                    placeholder="Search by name, key, model or person"
                    value={search.q ?? ""}
                    onValueChange={(q) => update({ q })}
                    className="w-full min-w-48 max-w-xs flex-1"
                />
                <CheckboxSelect
                    label="Scope"
                    allLabel="Any scope"
                    noun="scopes"
                    options={options}
                    value={scopes}
                    onValueChange={(next) => update({ scope: next.join(",") })}
                />
                {filtering && (
                    <Button variant="ghost" onClick={clear}>
                        <ListFilter aria-hidden="true" />
                        Clear filters
                    </Button>
                )}
            </div>
            <ErrorLine error={list.error} />
            <KeysTable
                rows={rows}
                loading={list.isLoading}
                storageKey="minibrain.keys.all"
                onEdit={manager.edit}
                onRevoke={manager.revoke}
                empty={
                    filtering ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-muted-foreground">No keys match these filters.</p>
                            <Button variant="outline" onClick={clear}>
                                Clear filters
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-muted-foreground">No keys yet.</p>
                            <Button variant="outline" onClick={() => manager.create()}>
                                <KeyRound aria-hidden="true" />
                                Create key
                            </Button>
                        </div>
                    )
                }
            />
        </div>
    );
}

export function ApiKeysPage() {
    const can = useCan();
    const manager = useKeyManager();
    return (
        <Page wide>
            <PageHeader
                title="API keys"
                caption={
                    can.admin
                        ? "Every key on this install. Apps call /v1 with them; each reaches only the models in its scope."
                        : "Your keys. Apps call /v1 with them; each reaches only the models in its scope."
                }
                actions={
                    <Button onClick={() => manager.create()}>
                        <KeyRound aria-hidden="true" />
                        Create key
                    </Button>
                }
            />
            <KeyList manager={manager} />
            {manager.dialogs}
        </Page>
    );
}
