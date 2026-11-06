const DELETED = "(deleted)";

export function withDeleted(name: string, deleted: boolean | undefined): string {
    return deleted ? `${name} ${DELETED}` : name;
}

export function ModelName({
    name,
    deleted,
    className,
}: {
    name: string;
    deleted?: boolean;
    className?: string;
}) {
    return (
        <span className={className}>
            {name}
            {deleted && <span className="font-normal text-muted-foreground">{` ${DELETED}`}</span>}
        </span>
    );
}
