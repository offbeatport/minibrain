import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Button, Input, Label } from "obp-ui";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "~/api/client";
import { keys, useMinibrains } from "~/api/queries";
import { ErrorLine, Page, Section } from "~/components/Section";

export function HomePage() {
    const router = useRouter();
    const queryClient = useQueryClient();
    const { data } = useMinibrains();
    const [name, setName] = useState("");
    const create = useMutation({
        mutationFn: (value: string) =>
            unwrap(api.POST("/api/minibrains", { body: { name: value } })),
        onSuccess: async (minibrain) => {
            await queryClient.invalidateQueries({ queryKey: keys.minibrains });
            router.history.push(`/m/${minibrain.slug}/data`);
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (name.trim()) {
            create.mutate(name.trim());
        }
    };
    return (
        <Page>
            <div>
                <h1 className="text-xl font-semibold">Minibrains</h1>
                <p className="text-sm text-muted-foreground">
                    Each minibrain is a small model trained on your data and served on an
                    OpenAI-compatible endpoint. Everything runs on this machine.
                </p>
            </div>
            <Section
                title="New minibrain"
                caption="Start with a Classify task: text in, one label out."
            >
                <form onSubmit={submit} className="flex max-w-xl flex-wrap items-end gap-2">
                    <div className="flex min-w-64 flex-1 flex-col gap-1">
                        <Label htmlFor="minibrain-name">Name</Label>
                        <Input
                            id="minibrain-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Support triage"
                            autoFocus
                        />
                    </div>
                    <Button type="submit" disabled={!name.trim() || create.isPending}>
                        Create
                    </Button>
                </form>
                <div className="mt-2">
                    <ErrorLine error={create.error} />
                </div>
            </Section>
            {data && data.length > 0 && (
                <p className="text-sm text-muted-foreground">
                    {data.length} minibrain{data.length === 1 ? "" : "s"} on this install. Pick one
                    on the left.
                </p>
            )}
        </Page>
    );
}
