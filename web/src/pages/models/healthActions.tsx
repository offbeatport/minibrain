import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Input,
} from "obp-ui";
import { type ReactNode, useEffect, useState } from "react";
import { type ModelRow, api, unwrap } from "~/api/client";
import { useCatalog } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import type { HealthAction } from "~/components/models/HealthStatus";
import { modelPageHref, trainHref } from "~/lib/modelLinks";
import { bytes } from "~/lib/time";
import { AccessSteps } from "./Discover";
import type { Confirmation } from "./dialogs";

type Dialogs = "reimport" | "relocate" | "get_access";
type Opened = { kind: Dialogs; row: ModelRow };

function target(row: ModelRow) {
    return { params: { path: { name: row.key } } };
}

function listed(paths: string[]): string {
    return paths.length > 3
        ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`
        : paths.join(", ");
}

function retry(row: ModelRow) {
    return unwrap(api.POST("/api/models/{name}/retry", target(row)));
}

function confirmation(row: ModelRow, action: HealthAction): Confirmation | null {
    const files = row.health?.files ?? [];
    if (action.kind === "repair") {
        return {
            title: `Repair ${row.name}?`,
            description: (
                <p>
                    Downloads {files.length > 0 ? listed(files) : "the damaged files"} again from
                    the model hub at the pinned revision. Each file must match the SHA-256 saved at
                    install before it replaces the old copy; the other files stay as they are.
                </p>
            ),
            confirmLabel: "Repair",
            run: () => unwrap(api.POST("/api/models/{name}/repair", target(row))),
        };
    }
    if (action.kind === "verify") {
        return {
            title: `Verify ${row.name}'s files?`,
            description: (
                <p>
                    Reads every file{row.size_bytes ? ` (${bytes(row.size_bytes)})` : ""} and
                    compares it with the SHA-256 saved at install. Nothing is changed.
                </p>
            ),
            confirmLabel: "Verify files",
            run: () => unwrap(api.POST("/api/models/{name}/verify", target(row))),
        };
    }
    if (action.kind === "resume") {
        return {
            title: `${action.label} for ${row.name}?`,
            description: <p>It starts again; files that are already complete are kept.</p>,
            confirmLabel: action.label,
            run: () => retry(row),
        };
    }
    if (action.kind === "try_again") {
        return {
            title: `Start ${row.name} again?`,
            description: (
                <p>
                    Clears the start-up failure. It loads again the next time it is used, or at once
                    while it is deployed.
                </p>
            ),
            confirmLabel: "Try again",
            run: () => unwrap(api.POST("/api/models/{name}/recheck", target(row))),
        };
    }
    return null;
}

function link(row: ModelRow, action: HealthAction): string | null {
    if (action.kind === "storage") {
        return "/infrastructure/storage";
    }
    if (action.kind === "pick_variant") {
        return row.catalog_id ? `/discover/${encodeURIComponent(row.catalog_id)}` : "/discover";
    }
    if (action.kind === "find_smaller") {
        return "/discover";
    }
    if (action.kind === "open_base") {
        return modelPageHref(row.base_model ?? "");
    }
    if (action.kind === "retrain") {
        return trainHref(row.key);
    }
    return null;
}

export function useHealthActions({
    refresh,
    confirm,
    remove,
}: {
    refresh: () => Promise<unknown>;
    confirm: (confirmation: Confirmation) => void;
    remove: (row: ModelRow) => void;
}) {
    const router = useRouter();
    const [opened, setOpened] = useState<Opened | null>(null);
    const run = (row: ModelRow, action: HealthAction) => {
        if (action.kind === "remove") {
            remove(row);
            return;
        }
        if (
            action.kind === "reimport" ||
            action.kind === "relocate" ||
            action.kind === "get_access"
        ) {
            setOpened({ kind: action.kind, row });
            return;
        }
        const href = link(row, action);
        if (href) {
            router.history.push(href);
            return;
        }
        const step = confirmation(row, action);
        if (step) {
            confirm({ ...step, run: () => step.run().then(refresh) });
        }
    };
    const close = () => setOpened(null);
    const dialogs = (
        <>
            <LocationDialog opened={opened} onClose={close} refresh={refresh} />
            <AccessDialog opened={opened} onClose={close} refresh={refresh} />
        </>
    );
    return { run, dialogs };
}

function LocationDialog({
    opened,
    onClose,
    refresh,
}: {
    opened: Opened | null;
    onClose: () => void;
    refresh: () => Promise<unknown>;
}) {
    const [location, setLocation] = useState("");
    const open = opened?.kind === "reimport" || opened?.kind === "relocate";
    const relocating = opened?.kind === "relocate";
    useEffect(() => {
        if (opened) {
            setLocation("");
        }
    }, [opened]);
    const submit = useMutation({
        mutationFn: () => {
            const row = opened?.row;
            if (!row) {
                return Promise.resolve(null);
            }
            const request = { ...target(row), body: { location: location.trim() } };
            return relocating
                ? unwrap(api.POST("/api/models/{name}/relocate", request))
                : unwrap(api.POST("/api/models/{name}/reimport", request));
        },
        onSuccess: async () => {
            await refresh();
            onClose();
        },
    });
    const name = opened?.row.name ?? "";
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit.mutate();
                    }}
                    className="contents"
                >
                    <DialogHeader>
                        <DialogTitle>
                            {relocating ? `Point ${name} to a new location` : `Re-import ${name}`}
                        </DialogTitle>
                        <DialogDescription>
                            {relocating
                                ? "Give the folder on the server that now holds its files. Each file is checked against the saved list by size, then hashed in the background."
                                : "Give a folder on the server or an S3 path that holds an intact copy. Only missing or damaged files are copied, and each must match the SHA-256 saved at install."}
                        </DialogDescription>
                    </DialogHeader>
                    <Field id="health-location" label={relocating ? "Folder" : "Folder or S3 path"}>
                        <Input
                            id="health-location"
                            value={location}
                            onChange={(event) => setLocation(event.target.value)}
                            placeholder={
                                relocating
                                    ? "/data/models/qwen3-8b"
                                    : "/data/models/qwen3-8b or s3://models/qwen3-8b"
                            }
                            className="font-mono"
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </Field>
                    <ErrorLine error={submit.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!location.trim() || submit.isPending}>
                            {relocating ? "Point and verify" : "Re-import"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function AccessDialog({
    opened,
    onClose,
    refresh,
}: {
    opened: Opened | null;
    onClose: () => void;
    refresh: () => Promise<unknown>;
}) {
    const catalog = useCatalog();
    const row = opened?.kind === "get_access" ? opened.row : null;
    const entry = catalog.data?.entries.find((item) => item.id === row?.catalog_id);
    const again = useMutation({
        mutationFn: () => (row ? retry(row) : Promise.resolve(null)),
        onSuccess: async () => {
            await refresh();
            onClose();
        },
    });
    let steps: ReactNode = <p className="text-muted-foreground">Loading…</p>;
    if (catalog.data) {
        steps = <AccessSteps entry={entry} catalog={catalog.data} />;
    }
    return (
        <Dialog open={row !== null} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Get access to {row?.name}</DialogTitle>
                    <DialogDescription>{row?.health?.detail}</DialogDescription>
                </DialogHeader>
                {steps}
                <ErrorLine error={again.error ?? catalog.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={() => again.mutate()} disabled={again.isPending}>
                        Retry
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
