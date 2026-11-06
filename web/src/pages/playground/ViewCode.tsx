import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Link,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "obp-ui";
import { useState } from "react";
import { CopyButton } from "~/components/CopyButton";
import { API_REFERENCE_PATH } from "~/lib/modelLinks";
import { samples } from "~/lib/playground";

export function ViewCode({ body, disabled }: { body: Record<string, unknown>; disabled: boolean }) {
    const [open, setOpen] = useState(false);
    const items = samples(`${window.location.origin}/v1`, body);
    return (
        <>
            <Button variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
                View code
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>View code</DialogTitle>
                        <DialogDescription>
                            The request the Playground sends next, with these settings and this
                            conversation, for <span className="font-mono">/v1</span> and an API key
                            from Deployments. Fields the <span className="font-mono">openai</span>{" "}
                            SDK does not know go in <span className="font-mono">extra_body</span>.
                        </DialogDescription>
                    </DialogHeader>
                    <Tabs defaultValue="curl" className="min-w-0">
                        <TabsList variant="line">
                            {items.map((item) => (
                                <TabsTrigger key={item.id} value={item.id}>
                                    {item.label}
                                </TabsTrigger>
                            ))}
                        </TabsList>
                        {items.map((item) => (
                            <TabsContent
                                key={item.id}
                                value={item.id}
                                className="flex flex-col gap-2"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-sm text-muted-foreground">
                                        Replace YOUR_KEY with a key.
                                    </span>
                                    <CopyButton value={item.code} label={`Copy ${item.label}`} />
                                </div>
                                <pre className="max-h-[60vh] overflow-auto rounded-md border bg-secondary p-3 font-mono text-sm">
                                    {item.code}
                                </pre>
                            </TabsContent>
                        ))}
                    </Tabs>
                    <p className="text-sm text-muted-foreground">
                        Every field is described in the{" "}
                        <Link href={API_REFERENCE_PATH} className="text-primary hover:underline">
                            API reference
                        </Link>
                        .
                    </p>
                </DialogContent>
            </Dialog>
        </>
    );
}
