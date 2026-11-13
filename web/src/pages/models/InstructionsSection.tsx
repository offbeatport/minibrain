import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { MessageSquareText } from "lucide-react";
import { Button, Field, Textarea, useToast } from "obp-ui";
import { useState } from "react";
import { type ModelDetail, api, unwrap } from "~/api/client";
import { ErrorLine, PanelSection, errorMessage } from "~/components/Section";
import { useCan } from "~/lib/access";
import { playgroundHref } from "~/lib/modelLinks";

function Editor({ detail }: { detail: ModelDetail }) {
    const client = useQueryClient();
    const toast = useToast();
    const router = useRouter();
    const [text, setText] = useState(detail.instructions);
    const path = { params: { path: { name: detail.slug } } };
    const save = useMutation({
        mutationFn: async () => {
            await unwrap(
                api.PUT("/api/models/{name}/instructions", {
                    ...path,
                    body: { instructions: text },
                }),
            );
            return unwrap(
                api.POST("/api/models/{name}/versions", { ...path, body: { kind: "prompt" } }),
            );
        },
        onSuccess: async (version) => {
            await client.invalidateQueries();
            toast({
                title: `Instructions saved as v${version.number}`,
                description:
                    version.status === "evaluating"
                        ? "A prompt-only version with them is being scored."
                        : "A prompt-only version with them is ready to try.",
                tone: "success",
                action: {
                    label: "Try it",
                    onClick: () => router.history.push(playgroundHref(detail.slug)),
                },
            });
        },
        onError: async (error) => {
            await client.invalidateQueries();
            toast({
                title: "No new version was made",
                description: errorMessage(error),
                tone: "destructive",
            });
        },
    });
    const dirty = text.trim() !== detail.instructions.trim();
    return (
        <div className="flex flex-col gap-3">
            <Field
                id="model-instructions"
                label="System prompt"
                hint="Leave it empty for the preset's default, shown greyed out."
            >
                <Textarea
                    id="model-instructions"
                    className="min-h-32"
                    value={text}
                    placeholder={detail.default_instructions}
                    onChange={(event) => setText(event.target.value)}
                />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? "Saving…" : "Save and make a version"}
                </Button>
                {dirty && (
                    <Button variant="ghost" onClick={() => setText(detail.instructions)}>
                        Cancel
                    </Button>
                )}
                <ErrorLine error={save.error} />
            </div>
        </div>
    );
}

export function InstructionsSection({ detail }: { detail: ModelDetail }) {
    const can = useCan();
    return (
        <PanelSection
            icon={MessageSquareText}
            anchor="instructions"
            title="Instructions"
            tip="The system prompt every version starts from. Saving makes a prompt-only version you can try at once in the Playground."
        >
            {can.build ? (
                <Editor key={detail.instructions} detail={detail} />
            ) : (
                <p className="whitespace-pre-wrap text-base">
                    {detail.instructions || detail.default_instructions}
                </p>
            )}
        </PanelSection>
    );
}
