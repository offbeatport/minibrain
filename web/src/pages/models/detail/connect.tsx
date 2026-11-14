import { BookOpen } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
} from "obp-ui";
import type { ModelRow } from "~/api/client";
import { useModel } from "~/api/queries";
import { CopyButton } from "~/components/CopyButton";
import { HarnessConfigs } from "~/components/HarnessConfigs";
import { API_REFERENCE_PATH, modelPageHref } from "~/lib/modelLinks";
import { isDeployed } from "./header";

function feedbackCurl(baseUrl: string, model: string, key: string, kept: boolean): string {
    const body = {
        model,
        response_id: "chatcmpl-abc123",
        rating: "down",
        correction: "billing",
        ...(kept ? {} : { input: "I was charged twice" }),
    };
    return [
        `curl ${baseUrl}/feedback \\`,
        `  -H "Authorization: Bearer ${key}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${JSON.stringify(body, null, 4).replaceAll("\n", "\n  ")}'`,
    ].join("\n");
}

function Copyable({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-label">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="flex h-8 min-w-0 items-center gap-1 rounded-md border bg-muted pr-0.5 pl-3">
                <span className="flex-1 truncate font-mono text-sm">{value}</span>
                <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
            </span>
        </div>
    );
}

export function ConnectDialog({
    row,
    open,
    onOpenChange,
    keyValue = null,
}: {
    row: ModelRow;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    keyValue?: string | null;
}) {
    const baseUrl = `${window.location.origin}/v1`;
    const custom = row.kind === "custom";
    const detail = useModel(custom && open ? row.key : "");
    const kept = detail.data?.request_bodies.kept ?? false;
    const key = keyValue ?? "YOUR_KEY";
    const keysHref = modelPageHref(row.key, "api");
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{`Connect to ${row.name}`}</DialogTitle>
                    <DialogDescription>
                        {"OpenAI-compatible. "}
                        {keyValue ? (
                            "Your new key is filled in below; it is shown only once."
                        ) : (
                            <>
                                {"Replace YOUR_KEY with a key from "}
                                <Link
                                    href={keysHref}
                                    onClick={() => onOpenChange(false)}
                                    className="text-primary hover:underline"
                                >
                                    API keys
                                </Link>
                                {"."}
                            </>
                        )}
                    </DialogDescription>
                </DialogHeader>
                {!isDeployed(row) && (
                    <p className="text-warning">
                        Not deployed yet: calls are refused until you deploy it.
                    </p>
                )}
                <div className="grid gap-4 sm:grid-cols-[3fr_2fr]">
                    <Copyable label="Base URL" value={baseUrl} />
                    <Copyable label="Model" value={row.key} />
                </div>
                <HarnessConfigs
                    baseUrl={baseUrl}
                    model={row.key}
                    keyValue={keyValue}
                    hint={false}
                    extra={[
                        {
                            id: "feedback",
                            label: "Feedback",
                            language: "bash",
                            title: "Rate an answer by its id; corrections become training data",
                            code: feedbackCurl(baseUrl, row.key, key, kept),
                        },
                    ]}
                />
                <DialogFooter className="sm:justify-between">
                    <Button variant="ghost" asChild>
                        <Link href={API_REFERENCE_PATH} onClick={() => onOpenChange(false)}>
                            <BookOpen aria-hidden="true" />
                            API reference
                        </Link>
                    </Button>
                    <Button onClick={() => onOpenChange(false)}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
