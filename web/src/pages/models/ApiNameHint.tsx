import { Input } from "obp-ui";
import { useDeferredValue } from "react";
import { useApiName } from "~/api/queries";

export function ApiNameHint({ name, bare = false }: { name: string; bare?: boolean }) {
    const deferred = useDeferredValue(name);
    const preview = useApiName(deferred);
    const found = deferred.trim() ? preview.data : undefined;
    if (!found) {
        return null;
    }
    if (bare) {
        return (
            <span className="flex flex-col gap-1">
                <Input
                    id="create-api-name"
                    value={found.api_name}
                    disabled
                    readOnly
                    aria-label="API name"
                    className="font-mono"
                />
                {found.reserved && (
                    <span className="text-sm text-muted-foreground">
                        {`${found.reserved.name} belonged to a deleted model`}
                    </span>
                )}
            </span>
        );
    }
    return (
        <span className="text-sm text-muted-foreground">
            API name <span className="font-mono">{found.api_name}</span>
            {found.reserved && ` · ${found.reserved.name} belonged to a deleted model`}
        </span>
    );
}
