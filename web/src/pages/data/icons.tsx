import { Cloud, Database, Folder, FolderUp, type LucideIcon, Snowflake } from "lucide-react";
import type { SourceKind } from "./catalogue";

export const KIND_ICONS: Record<SourceKind, LucideIcon> = {
    upload: FolderUp,
    folder: Folder,
    s3: Cloud,
    database: Database,
    iceberg: Snowflake,
};

export function KindIcon({ kind, className }: { kind: SourceKind; className?: string }) {
    const Icon = KIND_ICONS[kind];
    return <Icon aria-hidden="true" className={className} />;
}
