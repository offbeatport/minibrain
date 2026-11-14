import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Layers, Power, Settings2, TriangleAlert } from "lucide-react";
import { Button, Input, Textarea, useToast } from "obp-ui";
import { useState } from "react";
import { type ModelDetail, type ModelRow, api, unwrap } from "~/api/client";
import { useAllModels, usePlacement } from "~/api/queries";
import { FormRow, FormRows } from "~/components/FormRows";
import { RequestBodies } from "~/components/RequestBodies";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { TAGS_HINT, editableTags } from "~/components/Tags";
import { ModelAvatar as AvatarImage } from "~/components/avatar/ModelAvatar";
import { useCan } from "~/lib/access";
import { modelsHref } from "~/lib/modelsSearch";
import { beingDeleted, busyTearingDown, deleteModel, rowId, setDeployed } from "~/lib/teardown";
import { ChangeAvatarDialog } from "../ChangeAvatarDialog";
import { DeleteModelsDialog } from "../DeleteModelsDialog";
import { DuplicateModelDialog } from "../DuplicateModelDialog";
import { SwitchBaseDialog } from "../SwitchBaseDialog";
import { ConfirmAction, type Confirmation, splitTags, useModelsRefresh } from "../dialogs";
import type { Entry } from "../entries";
import { DeploymentStatus, Tip, baseNameOf, deployConfirmation, isDeployed } from "./header";
import { ReplicasRow, replicasText } from "./poolPicker";

export function useReload(row: ModelRow) {
    const refresh = useModelsRefresh();
    const client = useQueryClient();
    return async () => {
        await refresh();
        await client.invalidateQueries({ queryKey: ["model", row.key] });
        await client.invalidateQueries({ queryKey: ["all-models", "page", row.key] });
    };
}

export function sameList(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}

function General({ row }: { row: ModelRow }) {
    const toast = useToast();
    const reload = useReload(row);
    const can = useCan();
    const custom = row.kind === "custom";
    const [name, setName] = useState(row.name);
    const [description, setDescription] = useState(row.description);
    const [tags, setTags] = useState(editableTags(row.tags));
    const [picking, setPicking] = useState(false);
    const nextTags = splitTags(tags);
    const dirty =
        name.trim() !== row.name ||
        description.trim() !== row.description.trim() ||
        !sameList(nextTags, splitTags(editableTags(row.tags)));
    const locked = beingDeleted(row) || (!custom && !can.admin);
    const save = useMutation({
        mutationFn: () =>
            unwrap(
                api.PATCH("/api/models/{name}", {
                    params: { path: { name: row.key } },
                    body: { name: name.trim(), description: description.trim(), tags: nextTags },
                }),
            ),
        onSuccess: async () => {
            await reload();
            toast({ title: "Saved", description: name.trim(), tone: "success" });
        },
    });
    return (
        <PanelSection
            icon={Settings2}
            anchor="general"
            title="General"
            actions={
                <Button
                    variant="outline"
                    disabled={!dirty || !name.trim() || locked || save.isPending}
                    onClick={() => save.mutate()}
                >
                    Save
                </Button>
            }
        >
            <FormRows>
                <FormRow
                    id="settings-name"
                    label="Name"
                    tip={`Renaming keeps the API name ${row.key}; apps keep working.`}
                >
                    <Input
                        id="settings-name"
                        value={name}
                        readOnly={locked || save.isPending}
                        onChange={(event) => setName(event.target.value)}
                        className="w-full max-w-sm"
                    />
                </FormRow>
                {custom && (
                    <FormRow label="Avatar" align="start">
                        <AvatarImage name={row.name} avatar={row.avatar} size="xl" />
                        <Button
                            variant="outline"
                            disabled={locked}
                            onClick={() => setPicking(true)}
                        >
                            Change
                        </Button>
                    </FormRow>
                )}
                <FormRow id="settings-description" label="Description" align="start">
                    <Textarea
                        id="settings-description"
                        value={description}
                        rows={2}
                        readOnly={locked || save.isPending}
                        onChange={(event) => setDescription(event.target.value)}
                        className="w-full max-w-sm"
                    />
                </FormRow>
                <FormRow id="settings-tags" label="Tags" tip={TAGS_HINT}>
                    <Input
                        id="settings-tags"
                        value={tags}
                        placeholder="team:support, env:prod"
                        readOnly={locked || save.isPending}
                        onChange={(event) => setTags(event.target.value)}
                        className="w-full max-w-sm"
                    />
                </FormRow>
            </FormRows>
            <ErrorLine error={save.error} />
            {custom && <ChangeAvatarDialog row={row} open={picking} onOpenChange={setPicking} />}
        </PanelSection>
    );
}

function ReplicasSetting({ row, busy }: { row: ModelRow; busy: string | null }) {
    const reload = useReload(row);
    const toast = useToast();
    const placement = usePlacement(row.key, true);
    const target = placement.data?.pool ?? null;
    const current = row.deployment.replicas ?? 1;
    const [picked, setPicked] = useState<number | null>(null);
    const chosen = picked ?? current;
    const moving = row.deployment.moving_to
        ? `It is moving to ${row.deployment.moving_to}: change replicas once that ends.`
        : null;
    const blocked = busy ?? moving;
    const save = useMutation({
        mutationFn: () => setDeployed(row, true, undefined, chosen),
        onSuccess: async () => {
            await reload();
            setPicked(null);
            toast({ title: `${row.name} keeps ${replicasText(chosen)}`, tone: "success" });
        },
    });
    return (
        <ReplicasRow
            placement={placement.data}
            target={target}
            value={chosen}
            onChange={setPicked}
            disabled={Boolean(blocked) || save.isPending}
            note={blocked}
            selectClassName="w-48"
        >
            <Tip tip={blocked}>
                <Button
                    variant="outline"
                    disabled={Boolean(blocked) || chosen === current || save.isPending}
                    onClick={() => save.mutate()}
                >
                    Save
                </Button>
            </Tip>
            <ErrorLine error={save.error ?? placement.error} />
        </ReplicasRow>
    );
}

function Deployment({ row }: { row: ModelRow }) {
    const reload = useReload(row);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const busy = busyTearingDown(row) ? (row.teardown?.label ?? "Busy") : null;
    return (
        <PanelSection icon={Power} anchor="deployment" title="Deployment">
            <FormRows>
                <ReplicasSetting row={row} busy={busy} />
                <FormRow label="Undeploy" detail={<DeploymentStatus row={row} brief />}>
                    <Tip tip={busy}>
                        <Button
                            variant="outline"
                            disabled={Boolean(busy)}
                            onClick={() => setConfirmation(deployConfirmation(row, true, reload))}
                        >
                            Undeploy
                        </Button>
                    </Tip>
                </FormRow>
            </FormRows>
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </PanelSection>
    );
}

function Danger({ row, detail }: { row: ModelRow; detail: ModelDetail | undefined }) {
    const router = useRouter();
    const can = useCan();
    const refresh = useModelsRefresh();
    const models = useAllModels();
    const [duplicating, setDuplicating] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [deleting, setDeleting] = useState<Entry[] | null>(null);
    const custom = row.kind === "custom";
    const moveTo = (detail?.serve_only ?? row.serve_only)?.switch_to ?? null;
    const gone = beingDeleted(row) ? "It is being deleted." : null;
    const deleteBlock =
        gone ?? (custom || can.admin ? null : "Only an admin can delete a base model.");
    return (
        <>
            {custom && (
                <PanelSection icon={Layers} anchor="base" title="Base and copies">
                    <FormRows>
                        {custom && (
                            <FormRow
                                label={moveTo ? `Move to ${moveTo.name}` : "Switch base"}
                                detail={`On ${baseNameOf(models.data, row.base_model)}`}
                            >
                                <Tip tip={gone}>
                                    <Button
                                        variant="outline"
                                        disabled={Boolean(gone)}
                                        onClick={() => setSwitching(true)}
                                    >
                                        {moveTo ? "Move" : "Switch base"}
                                    </Button>
                                </Tip>
                            </FormRow>
                        )}
                        {custom && (
                            <FormRow label="Duplicate" detail="Same settings, another dataset">
                                <Tip tip={gone}>
                                    <Button
                                        variant="outline"
                                        disabled={Boolean(gone)}
                                        onClick={() => setDuplicating(true)}
                                    >
                                        Duplicate
                                    </Button>
                                </Tip>
                            </FormRow>
                        )}
                    </FormRows>
                </PanelSection>
            )}
            <PanelSection icon={TriangleAlert} anchor="danger" title="Danger zone">
                <FormRows>
                    <FormRow
                        label="Delete"
                        detail={custom ? "With every version and key" : "With its files and keys"}
                    >
                        <Tip tip={deleteBlock}>
                            <Button
                                variant="destructive"
                                disabled={Boolean(deleteBlock)}
                                onClick={() =>
                                    setDeleting([{ key: rowId(row), model: row, version: null }])
                                }
                            >
                                Delete model
                            </Button>
                        </Tip>
                    </FormRow>
                </FormRows>
                {custom && (
                    <>
                        <DuplicateModelDialog
                            row={duplicating ? row : null}
                            onOpenChange={(open) => !open && setDuplicating(false)}
                        />
                        <SwitchBaseDialog
                            row={switching ? row : null}
                            preferred={moveTo?.key ?? null}
                            onOpenChange={(open) => !open && setSwitching(false)}
                        />
                    </>
                )}
                <DeleteModelsDialog
                    chosen={deleting}
                    rows={models.data ?? []}
                    onOpenChange={(open) => !open && setDeleting(null)}
                    onDelete={async (cascade, cancelJobs) => {
                        await deleteModel(row, { cascade, undeploy: true, cancelJobs });
                        await refresh();
                        router.history.push(modelsHref());
                    }}
                />
            </PanelSection>
        </>
    );
}

export function SettingsTab({ row, detail }: { row: ModelRow; detail: ModelDetail | undefined }) {
    const can = useCan();
    const custom = row.kind === "custom";
    return (
        <PanelSections>
            {(custom || can.admin) && <General key={row.updated_at} row={row} />}
            {isDeployed(row) && <Deployment row={row} />}
            {detail && <RequestBodies detail={detail} />}
            <Danger row={row} detail={detail} />
        </PanelSections>
    );
}
