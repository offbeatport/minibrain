import { useRouter } from "@tanstack/react-router";
import {
    Badge,
    Button,
    Link,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "obp-ui";
import type { ReactNode } from "react";
import type { BaseModelDetail, ModelRow, VersionInfo } from "~/api/client";
import { useVersionFiles } from "~/api/queries";
import { Facts } from "~/components/Facts";
import { ErrorLine } from "~/components/Section";
import { useCan } from "~/lib/access";
import { modelPageHref } from "~/lib/modelLinks";
import { bytes, relativeTime } from "~/lib/time";
import { FileTable } from "./parts";

export function FilesSheet({
    row,
    open,
    description,
    children,
}: {
    row: ModelRow;
    open: boolean;
    description: ReactNode;
    children: ReactNode;
}) {
    const router = useRouter();
    return (
        <Sheet
            open={open}
            onOpenChange={(next) => !next && router.history.push(modelPageHref(row.key))}
        >
            <SheetContent side="right" className="sm:max-w-3xl">
                <SheetHeader>
                    <SheetTitle>{`${row.name} files`}</SheetTitle>
                    <SheetDescription>{description}</SheetDescription>
                </SheetHeader>
                {children}
            </SheetContent>
        </Sheet>
    );
}

export function baseWeightsText(model: BaseModelDetail): string {
    const checked = model.verified_at
        ? `verified ${relativeTime(model.verified_at)}`
        : "not verified yet";
    return `${model.files.length} files · ${bytes(model.size_bytes)} · ${checked}`;
}

export function verifiedText(model: BaseModelDetail): string {
    if (!model.verified_at) {
        return "Each file is checked against the SHA-256 saved at install.";
    }
    return `Each file is checked against the SHA-256 saved at install; last verified ${relativeTime(model.verified_at)}.`;
}

function storageFacts(model: BaseModelDetail): [string, ReactNode][] {
    const facts: [string, ReactNode][] = [
        [
            "Verification",
            model.verified ? (
                "Every file matches the catalogue checksums"
            ) : (
                <Badge key="verification" variant="warning">
                    Not verified against the catalogue
                </Badge>
            ),
        ],
        [
            "Content hash",
            model.content_hash ? (
                <span key="hash" className="font-mono">
                    {model.content_hash.slice(0, 16)}
                </span>
            ) : (
                "—"
            ),
        ],
        [
            "Storage",
            model.store === "s3" ? (
                model.store_label
            ) : (
                <span key="storage" className="font-mono">
                    {model.storage_path}
                </span>
            ),
        ],
    ];
    if (model.store === "s3") {
        facts.push([
            "Main's working copy",
            <span key="copy" className="font-mono">
                {model.storage_path}
            </span>,
        ]);
    }
    return facts;
}

export function BaseFiles({ model, verify }: { model: BaseModelDetail; verify: () => void }) {
    const can = useCan();
    const busy = ["running", "queued"].includes(model.activity.state);
    return (
        <div className="flex flex-col gap-4">
            {can.admin && model.availability.state === "available" && (
                <Button variant="outline" className="w-fit" onClick={verify} disabled={busy}>
                    Verify files
                </Button>
            )}
            <FileTable files={model.files} empty="No files yet." />
            <Facts items={storageFacts(model)} />
        </div>
    );
}

export function liveVersion(
    versions: VersionInfo[] | undefined,
    current: number | null | undefined,
): VersionInfo | undefined {
    return versions?.find((version) => version.number === current);
}

export function adapterText(live: VersionInfo | undefined, base: string): string {
    if (!live) {
        return `No version is live; ${base} answers with its own weights.`;
    }
    if (live.kind !== "lora") {
        return `v${live.number} is prompt only: no adapter, it runs on ${base}'s weights.`;
    }
    return `v${live.number} adds a LoRA adapter to ${base}'s weights.`;
}

export function CustomFiles({
    slug,
    live,
    base,
    baseName,
}: {
    slug: string;
    live: VersionInfo | undefined;
    base: string;
    baseName: string;
}) {
    const trained = live?.kind === "lora" ? live.number : null;
    const files = useVersionFiles(slug, trained);
    return (
        <div className="flex flex-col gap-4">
            {trained !== null && (
                <>
                    <ErrorLine error={files.error} />
                    <FileTable
                        files={files.data?.files ?? []}
                        loading={files.isLoading}
                        empty="The adapter has no files."
                    />
                    {files.data?.artifact_id && (
                        <Facts
                            items={[
                                [
                                    "Packed adapter",
                                    <span key="artifact" className="font-mono">
                                        {files.data.artifact_id.slice(0, 16)}
                                    </span>,
                                ],
                                [
                                    "Size",
                                    <span key="size" className="tabular-nums">
                                        {bytes(files.data.size)}
                                    </span>,
                                ],
                            ]}
                        />
                    )}
                </>
            )}
            <Button variant="outline" className="w-fit" asChild>
                <Link href={modelPageHref(base, "files")}>{`${baseName} files`}</Link>
            </Button>
        </div>
    );
}
