import { useRouter } from "@tanstack/react-router";
import { ArrowRight, Combine, FolderPlus, Grid2x2Plus, Plus } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    FileTypeIcon,
    Kbd,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { useConnections } from "~/api/connectionQueries";
import { useFolderRoots } from "~/api/dataQueries";
import { useDemoData } from "~/api/queries";
import { useCan } from "~/lib/access";
import { count } from "~/lib/format";
import { type AddKind, SOURCE_CHOICES, type SourceAdder, addSourceKind } from "./AddSource";
import { usable } from "./Connected";
import { type SourceGroupId, plural } from "./catalogue";
import { GroupIcon } from "./icons";

type Fix = "connections" | "security";

type Block = { short: string; why: string; fixes: Fix[] };

export type SourceBlocks = Partial<Record<SourceGroupId, Block>>;

const FIXES: Record<Fix, { label: string; href: string }> = {
    connections: { label: "Open connections", href: "/settings/connections" },
    security: { label: "Open security settings", href: "/settings/security" },
};

const OWN_KEYS =
    '[role="tree"],[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"]';

export function useSourceBlocks(): SourceBlocks {
    const connections = useConnections();
    const roots = useFolderRoots();
    const noFolders = roots.data !== undefined && roots.data.roots.length === 0;
    const noS3 = connections.data !== undefined && usable(connections.data, "s3").length === 0;
    const noDatabase =
        connections.data !== undefined && usable(connections.data, "database").length === 0;
    const blocks: SourceBlocks = {};
    if (noFolders) {
        blocks.folder = {
            short: "No folders allowed yet",
            why: "For safety, minibrain only reads folders an admin allows under Settings, Security, Folder sources.",
            fixes: ["security"],
        };
    }
    if (noS3) {
        blocks.s3 = {
            short: "No S3 connection yet",
            why: "S3 paths are read through a connection, and there is none yet. An admin adds one under Settings, Connections.",
            fixes: ["connections"],
        };
    }
    if (noDatabase) {
        blocks.database = {
            short: "No database connection yet",
            why: "Tables and queries are read through a PostgreSQL or MySQL connection, and there is none yet. An admin adds one under Settings, Connections.",
            fixes: ["connections"],
        };
    }
    if (noS3 && noFolders) {
        blocks.lakehouse = {
            short: "No S3 connection or allowed folder yet",
            why: "Iceberg tables are read through an S3 connection and Delta Lake tables from an allowed folder, and there is neither yet. An admin sets them up under Settings, Connections and Settings, Security.",
            fixes: ["connections", "security"],
        };
    }
    return blocks;
}

export function SourceChoices({
    groups,
    blocks,
    detailed = false,
    onPick,
}: {
    groups?: SourceGroupId[];
    blocks: SourceBlocks;
    detailed?: boolean;
    onPick: (group: SourceGroupId) => void;
}) {
    const choices = groups
        ? SOURCE_CHOICES.filter((choice) => groups.includes(choice.group))
        : SOURCE_CHOICES;
    return choices.map((choice) => {
        const block = blocks[choice.group];
        const item = (
            <DropdownMenuItem
                key={choice.group}
                disabled={block !== undefined}
                onSelect={() => onPick(choice.group)}
                className={detailed ? "items-start" : undefined}
            >
                <GroupIcon group={choice.group} className={detailed ? "mt-0.5" : undefined} />
                {detailed ? (
                    <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-medium">{choice.label}</span>
                        <span className="text-sm text-muted-foreground">
                            {block?.short ?? choice.detail}
                        </span>
                    </span>
                ) : (
                    choice.label
                )}
            </DropdownMenuItem>
        );
        if (!block) {
            return item;
        }
        return (
            <Tooltip key={choice.group}>
                <TooltipTrigger asChild>
                    <span className="block">{item}</span>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-72">
                    {block.why}
                </TooltipContent>
            </Tooltip>
        );
    });
}

function ownsKey(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    return (
        target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        target.closest(OWN_KEYS) !== null
    );
}

function useOpenKey(setOpen: Dispatch<SetStateAction<boolean>>, enabled: boolean) {
    useEffect(() => {
        if (!enabled) {
            return;
        }
        const onKey = (event: KeyboardEvent) => {
            const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
            if (
                plain &&
                event.key.toLowerCase() === "n" &&
                !event.defaultPrevented &&
                !ownsKey(event.target)
            ) {
                event.preventDefault();
                setOpen(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [setOpen, enabled]);
}

export function AddMenu({
    adder,
    picked,
    onAdd,
    onNewDataset,
    onNewFolder,
    onFromSources,
    startOpen = false,
}: {
    adder: SourceAdder;
    picked: number;
    onAdd: (kind: AddKind) => void;
    onNewDataset: () => void;
    onNewFolder: () => void;
    onFromSources: () => void;
    startOpen?: boolean;
}) {
    const router = useRouter();
    const demos = useDemoData();
    const blocks = useSourceBlocks();
    const can = useCan();
    const [open, setOpen] = useState(startOpen);
    const idle = adder.pending === null;
    useOpenKey(setOpen, idle);
    const pick = addSourceKind(adder, onAdd);
    const fixes = can.admin
        ? (Object.keys(FIXES) as Fix[]).filter((fix) =>
              Object.values(blocks).some((block) => block.fixes.includes(fix)),
          )
        : [];
    const demoList = demos.data ?? [];
    const label =
        adder.pending === "upload" ? "Uploading…" : adder.pending === "demo" ? "Adding…" : "Add";
    return (
        <DropdownMenu open={open && idle} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild data-slot="button">
                <Button disabled={!idle} aria-keyshortcuts="n">
                    <Plus />
                    {label}
                    {idle && <Kbd aria-hidden="true">N</Kbd>}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuGroup>
                    <DropdownMenuLabel>Dataset</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={onNewDataset}>
                        <Grid2x2Plus />
                        New dataset
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onNewFolder}>
                        <FolderPlus />
                        New folder
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onFromSources}>
                        <Combine />
                        {picked > 0 ? `From ${plural(picked, "selected source")}` : "From sources…"}
                    </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                    <DropdownMenuLabel>Source</DropdownMenuLabel>
                    <SourceChoices blocks={blocks} detailed onPick={pick} />
                    {fixes.map((fix) => (
                        <DropdownMenuItem
                            key={fix}
                            onSelect={() => router.history.push(FIXES[fix].href)}
                        >
                            <ArrowRight />
                            {FIXES[fix].label}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuGroup>
                {(demoList.length > 0 || demos.error) && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                            <DropdownMenuLabel>Demo data</DropdownMenuLabel>
                            {demoList.map((item) => (
                                <DropdownMenuItem
                                    key={item.file}
                                    onSelect={() => adder.addDemo(item.file)}
                                    className="items-start"
                                >
                                    <FileTypeIcon name={item.file} className="mt-0.5" />
                                    <span className="flex min-w-0 flex-col gap-0.5">
                                        <span className="font-medium">{item.name}</span>
                                        <span className="text-sm text-muted-foreground tabular-nums">
                                            {`${item.format} · ${count(item.rows)} rows · ${count(item.labels)} labels`}
                                        </span>
                                    </span>
                                </DropdownMenuItem>
                            ))}
                            {demos.error ? (
                                <p className="px-2.5 py-1.5 text-destructive">
                                    Demo data could not be listed.
                                </p>
                            ) : null}
                        </DropdownMenuGroup>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
