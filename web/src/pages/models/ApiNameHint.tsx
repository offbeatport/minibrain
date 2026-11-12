import { useDeferredValue } from "react";
import { useApiName } from "~/api/queries";

export function ApiNameHint({ name }: { name: string }) {
    const deferred = useDeferredValue(name);
    const preview = useApiName(deferred);
    const found = deferred.trim() ? preview.data : undefined;
    if (!found) {
        return null;
    }
    return (
        <span className="text-sm text-muted-foreground">
            API name <span className="font-mono">{found.api_name}</span>
            {found.reserved && ` · ${found.reserved.name} belonged to a deleted model`}
        </span>
    );
}
