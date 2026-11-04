import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    SearchList,
} from "obp-ui";
import type { CatalogEntry } from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import { bytes } from "~/lib/time";
import { memoryNeeded, parameters } from "./Discover";

function smallestDownload(entry: CatalogEntry): number {
    return Math.min(...entry.variants.map((variant) => variant.size_bytes));
}

function candidates(entries: CatalogEntry[], compared: string[]): CatalogEntry[] {
    const taken = new Set(compared);
    const families = new Set(
        entries.filter((entry) => taken.has(entry.id)).map((entry) => entry.family),
    );
    return entries
        .filter((entry) => !taken.has(entry.id))
        .sort(
            (a, b) =>
                Number(families.has(b.family)) - Number(families.has(a.family)) ||
                b.popularity - a.popularity,
        );
}

function Candidate({ entry }: { entry: CatalogEntry }) {
    return (
        <>
            <PublisherLogo publisher={entry.provider} name={entry.name} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold">{entry.name}</span>
                <span className="truncate text-muted-foreground">{entry.provider}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end tabular-nums">
                <span>
                    {`${parameters(entry)} · ${entry.variants.length > 1 ? "from " : ""}${bytes(smallestDownload(entry))} download`}
                </span>
                <span className="text-muted-foreground">{`${memoryNeeded(entry)} memory`}</span>
            </span>
        </>
    );
}

export function ComparePicker({
    open,
    onOpenChange,
    entries,
    compared,
    onPick,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    entries: CatalogEntry[];
    compared: string[];
    onPick: (entry: CatalogEntry) => void;
}) {
    const items = candidates(entries, compared);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Add model to compare</DialogTitle>
                    <DialogDescription>
                        Catalogue models not in the comparison yet. Models from the same families
                        come first.
                    </DialogDescription>
                </DialogHeader>
                <SearchList
                    items={items}
                    itemKey={(entry) => entry.id}
                    itemText={(entry) =>
                        `${entry.name} ${entry.provider} ${entry.family} ${entry.repo}`
                    }
                    renderItem={(entry) => <Candidate entry={entry} />}
                    onPick={(entry) => {
                        onPick(entry);
                        onOpenChange(false);
                    }}
                    label="Search the catalogue"
                    placeholder="Search by name, publisher or family"
                    empty={
                        items.length === 0
                            ? "Every catalogue model is already in the comparison."
                            : "No catalogue model matches."
                    }
                />
            </DialogContent>
        </Dialog>
    );
}
