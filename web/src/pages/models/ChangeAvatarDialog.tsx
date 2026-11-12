import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "obp-ui";
import { type ModelRow, api, unwrap } from "~/api/client";
import { keys } from "~/api/queries";
import { errorMessage } from "~/components/Section";
import { PickerDialog } from "~/components/avatar/AvatarPicker";
import { type AvatarChoice, avatarBody, choiceOfModel } from "~/components/avatar/avatarSvg";
import { useModelsRefresh } from "./dialogs";

export function ChangeAvatarDialog({
    row,
    open,
    onOpenChange,
}: {
    row: ModelRow;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const toast = useToast();
    const refresh = useModelsRefresh();
    const client = useQueryClient();
    const save = useMutation({
        mutationFn: (choice: AvatarChoice) =>
            unwrap(
                api.PUT("/api/models/{slug}/avatar", {
                    params: { path: { slug: row.key } },
                    body: avatarBody(choice),
                }),
            ),
        onSuccess: async () => {
            toast({ title: "Avatar changed", description: row.name, tone: "success" });
            await Promise.all([
                refresh(),
                client.invalidateQueries({ queryKey: keys.modelPage(row.key) }),
                client.invalidateQueries({ queryKey: keys.model(row.key) }),
            ]);
        },
        onError: (error) =>
            toast({
                title: "The avatar was not changed",
                description: errorMessage(error),
                tone: "destructive",
            }),
    });
    return (
        <PickerDialog
            open={open}
            onOpenChange={onOpenChange}
            name={row.name}
            value={choiceOfModel(row.avatar, row.name)}
            onUse={(choice) => save.mutate(choice)}
        />
    );
}
