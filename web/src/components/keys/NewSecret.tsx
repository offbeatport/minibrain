import {
    Button,
    CodeBlock,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "obp-ui";
import type { ReactNode } from "react";
import type { KeyCreated } from "~/api/client";
import { HarnessConfigs } from "~/components/HarnessConfigs";
import { useChoices } from "./scope";

const PLACEHOLDER_MODEL = "MODEL_NAME";

function useSampleModel(created: KeyCreated | null): string {
    const choices = useChoices();
    if (!created) {
        return PLACEHOLDER_MODEL;
    }
    return created.models[0]?.key ?? choices[0]?.key ?? PLACEHOLDER_MODEL;
}

export function NewSecret({
    created,
    onDismiss,
    extra,
}: {
    created: KeyCreated | null;
    onDismiss: () => void;
    extra?: ReactNode;
}) {
    const model = useSampleModel(created);
    return (
        <Dialog open={created !== null} onOpenChange={(open) => !open && onDismiss()}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Copy your key now</DialogTitle>
                    <DialogDescription>
                        {`${created?.name ?? "The key"} is shown once. Store it where your app reads its secrets.`}
                    </DialogDescription>
                </DialogHeader>
                <CodeBlock
                    code={created?.secret ?? ""}
                    language="text"
                    copyLabel="Copy the key"
                    wrap
                />
                <div className="flex min-w-0 flex-col gap-label">
                    <span className="font-medium">Use it</span>
                    <HarnessConfigs
                        baseUrl={`${window.location.origin}/v1`}
                        model={model}
                        keyValue={created?.secret ?? null}
                    />
                </div>
                <DialogFooter>
                    {extra}
                    <Button onClick={onDismiss}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
