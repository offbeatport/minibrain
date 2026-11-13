import { useReservedName } from "~/api/queries";
import { NotFoundState } from "~/components/ErrorState";
import { useCan } from "~/lib/access";
import { modelsHref } from "~/lib/modelsSearch";
import { relativeTime } from "~/lib/time";

export function ApiName({ name }: { name: string }) {
    return <code className="font-mono text-foreground">{name}</code>;
}

export function ModelNotFound({ name }: { name: string }) {
    const can = useCan();
    const reserved = useReservedName(name);
    if (reserved.isLoading) {
        return <p className="text-muted-foreground">Loading…</p>;
    }
    const gone = reserved.data;
    return (
        <NotFoundState
            title="Model not found"
            primary={{ label: "Go to Models", href: modelsHref() }}
            secondary={can.build ? { label: "Add model", href: "/models/new" } : undefined}
            detail={
                gone
                    ? `${gone.model_name} was deleted ${relativeTime(gone.deleted_at)} by ${gone.deleted_by}. Its API name stays reserved so no other model answers to it.`
                    : undefined
            }
        >
            {gone ? (
                <>
                    <ApiName name={name} /> belonged to a deleted model.
                </>
            ) : (
                <>
                    No model is called <ApiName name={name} />. It may have been deleted or renamed.
                </>
            )}
        </NotFoundState>
    );
}
