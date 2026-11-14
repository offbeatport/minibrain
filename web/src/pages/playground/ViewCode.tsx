import {
    CodeTabs,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Link,
} from "obp-ui";
import { API_REFERENCE_PATH } from "~/lib/modelLinks";
import { samples } from "~/lib/playground";

export function ViewCode({
    body,
    open,
    onOpenChange,
}: {
    body: Record<string, unknown>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const items = samples(`${window.location.origin}/v1`, body);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>View code</DialogTitle>
                    <DialogDescription>
                        The request the Playground sends next, with these settings and this
                        conversation, for <span className="font-mono">/v1</span> and an API key from
                        Deployments. Fields the <span className="font-mono">openai</span> SDK does
                        not know go in <span className="font-mono">extra_body</span>.
                    </DialogDescription>
                </DialogHeader>
                <CodeTabs
                    items={items}
                    title="Replace YOUR_KEY with a key."
                    blockClassName="max-h-[60vh]"
                />
                <p className="text-sm text-muted-foreground">
                    Every field is described in the{" "}
                    <Link href={API_REFERENCE_PATH} className="text-primary hover:underline">
                        API reference
                    </Link>
                    .
                </p>
            </DialogContent>
        </Dialog>
    );
}
