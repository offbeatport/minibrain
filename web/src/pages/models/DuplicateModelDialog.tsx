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
    useToast,
} from "obp-ui";
import { useState } from "react";
import { type ModelRow, api, unwrap } from "~/api/client";
import { useAllModels } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { modelPageHref } from "~/lib/modelLinks";
import { useModelsRefresh } from "./dialogs";
import { isTaken, nextFree, takenNames } from "./names";

function copiedVersion(row: ModelRow): number | null {
    const ready = (row.versions ?? []).filter((version) => version.status === "ready");
    const live = ready.find((version) => version.number === row.current_version);
    const latest = ready.reduce<number | null>(
        (highest, version) => Math.max(highest ?? version.number, version.number),
        null,
    );
    return live?.number ?? latest;
}

function whatCopies(row: ModelRow): string {
    const version = copiedVersion(row);
    const settings =
        "Same base, answers, instructions, graders, promotion rule, training data, description and tags.";
    return version === null
        ? `${settings} It has no ready version to copy, so the copy starts at v0. Nothing is deployed.`
        : `${settings} Its v${version} becomes the copy's v1 with its scores, sharing the same stored files. Nothing is deployed.`;
}

export function DuplicateModelDialog({
    row,
    onOpenChange,
}: {
    row: ModelRow | null;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const toast = useToast();
    const refresh = useModelsRefresh();
    const models = useAllModels();
    const [typed, setTyped] = useState<{ key: string; value: string } | null>(null);
    const taken = takenNames(models.data ?? []);
    const suggested = row ? nextFree(`${row.name} copy`, taken, false) : "";
    const name = row && typed?.key === row.key ? typed.value : suggested;
    const trimmed = name.trim();
    const problem = !trimmed
        ? "Name the copy."
        : !/[A-Za-z0-9]/.test(trimmed)
          ? "Use at least one letter or number."
          : isTaken(trimmed, taken)
            ? `A model called ${trimmed} already exists. Pick another name.`
            : null;
    const duplicate = useMutation({
        mutationFn: (source: ModelRow) =>
            unwrap(
                api.POST("/api/models/{slug}/duplicate", {
                    params: { path: { slug: source.key } },
                    body: { name: trimmed },
                }),
            ),
        onSuccess: async (created) => {
            close();
            toast({ title: "Model duplicated", description: created.name, tone: "success" });
            await refresh();
            router.history.push(modelPageHref(created.slug));
        },
    });
    const close = () => {
        setTyped(null);
        duplicate.reset();
        onOpenChange(false);
    };
    return (
        <Dialog open={row !== null} onOpenChange={(open) => !open && close()}>
            <DialogContent>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (row && !problem && !duplicate.isPending) {
                            duplicate.mutate(row);
                        }
                    }}
                    className="contents"
                >
                    <DialogHeader>
                        <DialogTitle>{`Duplicate ${row?.name ?? ""}`}</DialogTitle>
                        <DialogDescription>{row ? whatCopies(row) : null}</DialogDescription>
                    </DialogHeader>
                    <Field id="duplicate-name" label="Name" error={problem ?? undefined}>
                        <Input
                            id="duplicate-name"
                            autoFocus
                            aria-invalid={Boolean(problem)}
                            value={name}
                            onChange={(event) =>
                                row && setTyped({ key: row.key, value: event.target.value })
                            }
                        />
                    </Field>
                    <ErrorLine error={duplicate.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={Boolean(problem) || duplicate.isPending}>
                            {duplicate.isPending ? "Duplicating…" : "Duplicate"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
